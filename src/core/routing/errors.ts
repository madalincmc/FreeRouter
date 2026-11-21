import type { ModelState } from '@shared/ipc'

/**
 * Failure classification for upstream calls (PRD §6). Used by "test now" in M2 and by the
 * router's fallback loop in M3. Provider-agnostic: it reads standard statuses and headers.
 */
export type FailureKind =
  | 'rate_limited' // 429, per-minute style
  | 'quota_exhausted' // 429 that says a daily cap is hit
  | 'payment' // 402 (OpenRouter negative balance)
  | 'auth' // 401/403: key invalid
  | 'context' // 400/413 because the prompt is too long for this model
  | 'bad_request' // other 400/422 (unsupported parameter, …)
  | 'not_found' // 404: model gone, renamed, or not offered to this account
  | 'no_free_quota' // 429 with a zero quota ("limit: 0"): the model isn't on this account's free tier
  | 'server' // 5xx / 408
  | 'timeout'
  | 'network'

export interface Failure {
  kind: FailureKind
  status?: number
  /** Epoch ms when the model may be retried, from headers or defaults. */
  retryAt?: number
  message: string
}

export const DEFAULT_COOLDOWN_MS = 60_000
/**
 * How long a model that this account can't use (404, or a zero free quota) stays out of routing.
 * These don't fix themselves within a day, so it's re-checked weekly instead of costing a
 * fallback on every request. Syncs keep the cooldown.
 */
export const UNAVAILABLE_COOLDOWN_MS = 7 * 24 * 60 * 60_000

/** Parses Groq-style durations ("2m59.56s", "7.66s", "1h2m", "250ms"). */
export function parseDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g
  let total = 0
  let matched = false
  for (const m of s.matchAll(re)) {
    matched = true
    const n = Number(m[1])
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n
  }
  return matched ? Math.round(total) : null
}

/** Reads the earliest reliable retry time from standard and common provider headers. */
export function retryAtFromHeaders(headers: { get(name: string): string | null }, now: number): number | undefined {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) return now + secs * 1000
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return date
  }
  for (const h of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = headers.get(h)
    const ms = v ? parseDuration(v) : null
    if (ms !== null) return now + ms
  }
  const reset = headers.get('x-ratelimit-reset')
  if (reset && /^\d+$/.test(reset)) {
    const n = Number(reset)
    // Epoch ms (OpenRouter), epoch seconds, or seconds-from-now.
    if (n > 1e12) return n
    if (n > 1e9) return n * 1000
    return now + n * 1000
  }
  return undefined
}

/** A quota whose limit is zero (Gemini: "Quota exceeded for metric: …free_tier…, limit: 0"). */
const ZERO_QUOTA_RE = /\blimit["']?\s*[:=]\s*0(?![\d.])/i
const DAILY_RE = /(per[\s_-]?day|daily|requests per day|\brpd\b|PerDay|free-models-per-day|day limit)/i
const CONTEXT_RE = /(context|too long|maximum.{0,20}tokens|token limit|prompt is too large|reduce the length)/i

export function nextUtcMidnight(now: number): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
}

/** Compiles a profile's `errors.unavailable` patterns (case-insensitive). */
export function unavailablePatterns(profile: { errors?: { unavailable: string[] } } | undefined): RegExp[] {
  return (profile?.errors?.unavailable ?? []).map((p) => new RegExp(p, 'i'))
}

export function classifyHttpFailure(
  status: number,
  headers: { get(name: string): string | null },
  body: string,
  now: number,
  /** Profile patterns for "this model isn't available to this account" (see `unavailablePatterns`). */
  unavailable: RegExp[] = []
): Failure {
  const message = body.slice(0, 300)
  const retryAt = retryAtFromHeaders(headers, now)
  if (status >= 400 && unavailable.some((re) => re.test(body))) {
    return { kind: 'no_free_quota', status, retryAt: now + UNAVAILABLE_COOLDOWN_MS, message }
  }
  if (status === 429) {
    if (ZERO_QUOTA_RE.test(body)) return { kind: 'no_free_quota', status, retryAt: now + UNAVAILABLE_COOLDOWN_MS, message }
    if (DAILY_RE.test(body)) return { kind: 'quota_exhausted', status, retryAt: retryAt ?? nextUtcMidnight(now), message }
    return { kind: 'rate_limited', status, retryAt: retryAt ?? now + DEFAULT_COOLDOWN_MS, message }
  }
  if (status === 402) return { kind: 'payment', status, retryAt: retryAt ?? now + 60 * 60_000, message }
  if (status === 401 || status === 403) return { kind: 'auth', status, message }
  if (status === 404) return { kind: 'not_found', status, retryAt: now + UNAVAILABLE_COOLDOWN_MS, message }
  if (status === 400 || status === 413 || status === 422) {
    return { kind: CONTEXT_RE.test(body) || status === 413 ? 'context' : 'bad_request', status, message }
  }
  if (status === 408 || status >= 500) return { kind: 'server', status, retryAt, message }
  return { kind: 'bad_request', status, message }
}

/** How a failure changes the model's live state. `undefined` state means "leave unchanged". */
export function stateForFailure(f: Failure): { state?: ModelState; cooldownUntil?: number | null } {
  switch (f.kind) {
    case 'rate_limited':
      return { state: 'cooling_down', cooldownUntil: f.retryAt ?? null }
    case 'quota_exhausted':
    case 'payment':
      return { state: 'quota_exhausted', cooldownUntil: f.retryAt ?? null }
    case 'not_found':
    case 'no_free_quota':
      return { state: 'cooling_down', cooldownUntil: f.retryAt ?? null }
    case 'server':
    case 'timeout':
    case 'network':
      return { state: 'degraded' }
    default:
      // auth is a key problem; context/bad_request are request problems – the model itself is fine.
      return {}
  }
}
