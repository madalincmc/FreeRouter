import type { KeyTestResult } from '@shared/ipc'
import type { ProviderProfile } from '../providers/catalog'
import { redact } from '../security/redact'

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number
  ok: boolean
  text(): Promise<string>
}>

export interface TestKeyOptions {
  fetch: FetchLike
  timeoutMs?: number
  now?: () => number
}

/** Pulls a human-readable message out of an error body, redacted and capped. */
function errorMessage(body: string): string {
  let msg = body
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown }
    const candidate =
      typeof json.error === 'string' ? json.error : (json.error?.message ?? json.message)
    if (typeof candidate === 'string') msg = candidate
  } catch {
    /* not JSON – use the raw text */
  }
  msg = redact(msg.replace(/\s+/g, ' ').trim())
  return msg.length > 200 ? `${msg.slice(0, 197)}…` : msg
}

/**
 * Runs the provider's cheap validation call (PRD §7) with the given key.
 * Never throws; network failures come back as `outcome: 'error'`.
 */
export async function testKey(profile: ProviderProfile, key: string, opts: TestKeyOptions): Promise<KeyTestResult> {
  const now = opts.now ?? Date.now
  const started = now()
  const { url, invalidStatuses, headers } = profile.validation
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000)
  const done = (r: Omit<KeyTestResult, 'latencyMs'>): KeyTestResult => ({ ...r, latencyMs: now() - started })

  try {
    const res = await opts.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers, Authorization: `Bearer ${key}` },
      signal: controller.signal
    })
    if (res.ok) return done({ outcome: 'valid', httpStatus: res.status, message: 'Key accepted' })

    const body = await res.text().catch(() => '')
    if (invalidStatuses.includes(res.status)) {
      return done({ outcome: 'invalid', httpStatus: res.status, message: errorMessage(body) || 'Key rejected' })
    }
    if (res.status === 429) {
      // Authenticated but rate-limited right now: the key itself is fine.
      return done({ outcome: 'valid', httpStatus: 429, message: 'Key accepted (currently rate-limited)' })
    }
    if (res.status === 402) {
      return done({ outcome: 'valid', httpStatus: 402, message: 'Key accepted, but the account needs credits (402)' })
    }
    return done({
      outcome: 'error',
      httpStatus: res.status,
      message: `Unexpected ${res.status}: ${errorMessage(body) || 'no details'}`
    })
  } catch (err) {
    const aborted = controller.signal.aborted
    return done({
      outcome: 'error',
      message: aborted ? 'Timed out reaching the provider' : `Network error: ${redact((err as Error).message ?? String(err))}`
    })
  } finally {
    clearTimeout(timer)
  }
}
