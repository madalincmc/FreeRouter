import type { KeyTestResult } from '@shared/ipc'
import type { FetchLike } from '../http'
import type { ProviderProfile } from '../providers/catalog'
import { redact } from '../security/redact'

export type { FetchLike }

export interface TestKeyOptions {
  fetch: FetchLike
  timeoutMs?: number
  now?: () => number
}

/** Pulls a human-readable message out of an error body, redacted and capped. */
export function errorMessage(body: string): string {
  let msg = body
  try {
    let parsed: unknown = JSON.parse(body)
    if (Array.isArray(parsed)) parsed = parsed[0] // Gemini wraps errors in an array
    const json = (parsed ?? {}) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown; title?: unknown }
    const candidate =
      typeof json.error === 'string'
        ? json.error
        : // RFC 7807 problem+json (NVIDIA) uses detail/title.
          (json.error?.message ?? json.message ?? json.detail ?? json.title)
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
  const { url, invalidStatuses, headers, method = 'GET', body: requestBody } = profile.validation
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000)
  const done = (r: Omit<KeyTestResult, 'latencyMs'>): KeyTestResult => ({ ...r, latencyMs: now() - started })

  try {
    const res = await opts.fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
        Authorization: `Bearer ${key}`
      },
      ...(requestBody ? { body: JSON.stringify(requestBody) } : {}),
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
