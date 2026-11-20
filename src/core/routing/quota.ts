import type Database from 'better-sqlite3'
import type { Limits } from '@shared/ipc'
import { parseDuration } from './errors'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** Counter key: OpenRouter-style account-wide limits share one counter across all models (`*`). */
export function counterKey(keyId: string, modelId: string, accountWide: boolean): string {
  return `${keyId}|${accountWide ? '*' : modelId}`
}

interface HeaderHint {
  remainingRequests?: number
  requestsResetAt?: number
  remainingTokens?: number
  tokensResetAt?: number
  at: number
}

export interface QuotaCheck {
  allowed: boolean
  /** 0..1 – remaining share of the tightest known budget (1 when nothing is known). */
  headroom: number
  reason?: string
}

const utcDayStart = (t: number): number => t - (t % DAY)

/**
 * Local quota counters (PRD §6): sliding 60 s windows for RPM/TPM in memory, per-UTC-day
 * RPD/TPD persisted in `usage_counters` so restarts don't reset the daily budget.
 * Real `x-ratelimit-*` headers override the local estimate when present.
 */
interface MinuteEntry {
  t: number
  requests: number
  tokens: number
}

export class QuotaTracker {
  private readonly minute = new Map<string, MinuteEntry[]>()
  private readonly hints = new Map<string, HeaderHint>()

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  private recentMinute(key: string): MinuteEntry[] {
    const cutoff = this.now() - MINUTE
    const list = (this.minute.get(key) ?? []).filter((e) => e.t > cutoff)
    this.minute.set(key, list)
    return list
  }

  private day(key: string): { requests: number; tokens: number } {
    const [keyId, modelId] = key.split('|') as [string, string]
    const row = this.db
      .prepare<[string, string, number], { requests: number; tokens: number }>(
        `SELECT requests, tokens FROM usage_counters WHERE key_id = ? AND model_id = ? AND window = 'day' AND window_start = ?`
      )
      .get(keyId, modelId, utcDayStart(this.now()))
    return row ?? { requests: 0, tokens: 0 }
  }

  /** Counts a request that was sent upstream (whatever its outcome). */
  recordRequest(key: string, tokens = 0): void {
    this.recentMinute(key).push({ t: this.now(), requests: 1, tokens })
    this.bumpDay(key, 1, tokens)
  }

  /** Adds completion tokens once they're known (tokens only – not another request). */
  recordTokens(key: string, tokens: number): void {
    if (tokens <= 0) return
    this.recentMinute(key).push({ t: this.now(), requests: 0, tokens })
    this.bumpDay(key, 0, tokens)
  }

  private bumpDay(key: string, requests: number, tokens: number): void {
    const [keyId, modelId] = key.split('|') as [string, string]
    this.db
      .prepare(
        `INSERT INTO usage_counters (key_id, model_id, window, window_start, requests, tokens) VALUES (?, ?, 'day', ?, ?, ?)
         ON CONFLICT(key_id, model_id, window, window_start)
         DO UPDATE SET requests = requests + excluded.requests, tokens = tokens + excluded.tokens`
      )
      .run(keyId, modelId, utcDayStart(this.now()), requests, tokens)
  }

  /** Reads standard rate-limit headers (Groq, OpenRouter, Cerebras, …) into a hint. */
  recordHeaders(key: string, headers: { get(name: string): string | null }): void {
    const now = this.now()
    const num = (h: string): number | undefined => {
      const v = headers.get(h)
      return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined
    }
    const reset = (h: string): number | undefined => {
      const v = headers.get(h)
      if (!v) return undefined
      if (/^\d+$/.test(v)) {
        const n = Number(v)
        return n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000
      }
      const ms = parseDuration(v)
      return ms === null ? undefined : now + ms
    }
    const hint: HeaderHint = {
      remainingRequests: num('x-ratelimit-remaining-requests') ?? num('x-ratelimit-remaining'),
      requestsResetAt: reset('x-ratelimit-reset-requests') ?? reset('x-ratelimit-reset'),
      remainingTokens: num('x-ratelimit-remaining-tokens'),
      tokensResetAt: reset('x-ratelimit-reset-tokens'),
      at: now
    }
    if (hint.remainingRequests !== undefined || hint.remainingTokens !== undefined) this.hints.set(key, hint)
  }

  /** Usage for one counter today. */
  usageToday(key: string): { requests: number; tokens: number } {
    return this.day(key)
  }

  /**
   * Today's requests for display (Models screen "Today"), summed over keys. Account-wide counters
   * (model `*`) are reported per provider, since they're shared by every model of that provider.
   */
  todayByModel(keyProvider: (keyId: string) => string | undefined): {
    perModel: Record<string, number>
    perProvider: Record<string, number>
  } {
    const rows = this.db
      .prepare<[number], { key_id: string; model_id: string; requests: number }>(
        `SELECT key_id, model_id, requests FROM usage_counters WHERE window = 'day' AND window_start = ?`
      )
      .all(utcDayStart(this.now()))
    const perModel: Record<string, number> = {}
    const perProvider: Record<string, number> = {}
    for (const r of rows) {
      if (r.model_id === '*') {
        const p = keyProvider(r.key_id)
        if (p) perProvider[p] = (perProvider[p] ?? 0) + r.requests
      } else {
        perModel[r.model_id] = (perModel[r.model_id] ?? 0) + r.requests
      }
    }
    return { perModel, perProvider }
  }

  check(key: string, limits: Limits, estTokens = 0): QuotaCheck {
    const now = this.now()
    const minute = this.recentMinute(key)
    const day = this.day(key)
    const usedTokensMinute = minute.reduce((s, e) => s + e.tokens, 0)
    const usedRequestsMinute = minute.reduce((s, e) => s + e.requests, 0)

    const shares: number[] = []
    const over = (used: number, limit: number | undefined, label: string): string | undefined => {
      if (!limit) return undefined
      shares.push(Math.max(0, 1 - used / limit))
      return used >= limit ? label : undefined
    }
    const reason =
      over(usedRequestsMinute, limits.rpm, 'RPM') ??
      over(day.requests, limits.rpd, 'RPD') ??
      over(usedTokensMinute + estTokens, limits.tpm, 'TPM') ??
      over(day.tokens + estTokens, limits.tpd, 'TPD')

    const hint = this.hints.get(key)
    if (hint) {
      if (hint.remainingRequests === 0 && (hint.requestsResetAt ?? 0) > now) {
        return { allowed: false, headroom: 0, reason: 'provider reports 0 requests remaining' }
      }
      if (hint.remainingTokens !== undefined && hint.remainingTokens < estTokens && (hint.tokensResetAt ?? 0) > now) {
        return { allowed: false, headroom: 0, reason: 'provider reports too few tokens remaining' }
      }
    }
    if (reason) return { allowed: false, headroom: 0, reason: `local ${reason} limit reached` }
    return { allowed: true, headroom: shares.length ? Math.min(...shares) : 1 }
  }
}
