import type { ProviderProfile } from './catalog'

/** A stored key resolved for one call: the bearer token, plus values for URL placeholders. */
export interface ResolvedKey {
  bearer: string
  vars: Record<string, string>
}

/** Thrown when a compound key doesn't have the profile's shape. The message never contains the key. */
export class KeyFormatError extends Error {}

/**
 * Splits a stored key per the profile's `credential` spec (Cloudflare: `ACCOUNT_ID:API_TOKEN`).
 * Plain keys pass through unchanged. The last part keeps any extra separators, so tokens may contain them.
 */
export function resolveKey(profile: Pick<ProviderProfile, 'credential' | 'name'>, raw: string): ResolvedKey {
  const key = raw.trim()
  const spec = profile.credential
  if (!spec) return { bearer: key, vars: {} }
  const pieces = key.split(spec.separator)
  const n = spec.parts.length
  const values = [...pieces.slice(0, n - 1), pieces.slice(n - 1).join(spec.separator)].map((v) => v?.trim() ?? '')
  if (pieces.length < n || values.some((v) => v.length === 0)) {
    throw new KeyFormatError(`${profile.name} keys are entered as ${spec.hint}`)
  }
  const vars: Record<string, string> = {}
  spec.parts.slice(0, n - 1).forEach((name, i) => (vars[name] = values[i]!))
  return { bearer: values[n - 1]!, vars }
}

/** Fills `{name}` placeholders (URL-encoded). Unknown placeholders are left as they are. */
export function fillUrl(url: string, vars: Record<string, string>): string {
  return url.replace(/\{([a-zA-Z]+)\}|%7B([a-zA-Z]+)%7D/g, (whole, a?: string, b?: string) => {
    const v = vars[(a ?? b)!]
    return v === undefined ? whole : encodeURIComponent(v)
  })
}

/** True when the URL still needs values from a key (so it can't be called without one). */
export function needsKeyVars(url: string): boolean {
  return /\{[a-zA-Z]+\}|%7B[a-zA-Z]+%7D/.test(url)
}
