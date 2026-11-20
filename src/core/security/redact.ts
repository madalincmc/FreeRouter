/**
 * The single redaction helper (PRD §7). Every log line and every error shown in the UI
 * passes through here so API keys and Authorization headers never leak.
 */

const REDACTED = '[REDACTED]'

/** `label: value` shapes – the label (group 1) is kept, the value is hidden. */
const LABELLED: RegExp[] = [
  /(authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',}]+/gi,
  /((?:x-api-key|x-goog-api-key|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
  /([?&](?:key|api_key|apikey|token)=)[^&\s"']+/gi
]

/** Bare tokens with a known provider prefix – the prefix (group 1) is kept. */
const BARE_TOKENS =
  /\b(sk-or-v1-|sk-or-|sk-ant-|sk-|gsk_|csk-|AIza|github_pat_|ghp_|nvapi-|hf_|fr-local-)[A-Za-z0-9_-]{8,}/g

export function redact(input: string): string {
  let out = input
  for (const re of LABELLED) out = out.replace(re, `$1${REDACTED}`)
  return out.replace(BARE_TOKENS, `$1${REDACTED}`)
}

/** Masks a key for display, e.g. `sk-or-…a91f`. */
export function maskKey(key: string): string {
  const k = key.trim()
  if (k.length <= 12) return `…${k.slice(-2)}`
  const prefix = /^(sk-or-|[A-Za-z]{2,4}[-_])/.exec(k)?.[1] ?? k.slice(0, 3)
  return `${prefix}…${k.slice(-4)}`
}

export function redactError(err: unknown): string {
  return redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
}
