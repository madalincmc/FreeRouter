import { getPath } from '../http'
import type { ModelsSpec } from '../providers/catalog'
import { fillUrl } from '../providers/credential'

/** One chat model as reported by a provider's model list, before seed/heuristic enrichment. */
export interface DiscoveredModel {
  modelId: string
  name: string | null
  isFree: boolean
  contextWindow: number | null
  maxOutput: number | null
  inputModalities: string[]
  supportedParameters: string[]
  toolsFlag: boolean | null
  visionFlag: boolean | null
  reasoningFlag: boolean | null
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const isZero = (v: unknown): boolean => v !== undefined && v !== null && Number(v) === 0

function detectFree(spec: ModelsSpec, entry: unknown, modelId: string): boolean {
  if ('all' in spec.free) return true
  if (spec.free.idSuffix && modelId.endsWith(spec.free.idSuffix)) return true
  const paths = spec.free.zeroPricePaths
  return !!paths && paths.length > 0 && paths.every((p) => isZero(getPath(entry, p)))
}

/**
 * Turns a provider's /models response into chat models, using only the profile's spec.
 * Throws if the response doesn't have the expected shape (so a broken sync never wipes the registry).
 */
export function parseModelList(spec: ModelsSpec, json: unknown): DiscoveredModel[] {
  const list = getPath(json, spec.listPath)
  if (!Array.isArray(list)) throw new Error(`Unexpected /models response: no array at "${spec.listPath || '(root)'}"`)

  const strip = spec.idStrip ? new RegExp(spec.idStrip) : null
  const excludes = spec.exclude.map((s) => s.toLowerCase())
  const f = spec.fields
  const seen = new Set<string>()
  const out: DiscoveredModel[] = []

  for (const entry of list) {
    const rawId = getPath(entry, f.id)
    if (typeof rawId !== 'string' || rawId.length === 0) continue
    const modelId = strip ? rawId.replace(strip, '') : rawId
    const lower = modelId.toLowerCase()

    if (seen.has(modelId)) continue
    if (excludes.some((x) => lower.includes(x))) continue
    if (f.active && getPath(entry, f.active) === false) continue
    if (f.chatFlag && getPath(entry, f.chatFlag) === false) continue
    if (f.deprecated && getPath(entry, f.deprecated) === true) continue
    if (spec.require?.some((r) => !strings(getPath(entry, r.path)).includes(r.includes))) continue
    // Chat routing needs text-only output; generators (image, music: text+audio) are not chat models.
    const outputs = f.outputModalities ? strings(getPath(entry, f.outputModalities)) : []
    if (outputs.length > 0 && outputs.some((o) => o !== 'text')) continue

    seen.add(modelId)
    const name = f.name ? getPath(entry, f.name) : undefined
    out.push({
      modelId,
      name: typeof name === 'string' && name.trim() ? name.trim() : null,
      isFree: detectFree(spec, entry, modelId),
      contextWindow: f.contextWindow ? num(getPath(entry, f.contextWindow)) : null,
      maxOutput: f.maxOutput ? num(getPath(entry, f.maxOutput)) : null,
      inputModalities: f.inputModalities ? strings(getPath(entry, f.inputModalities)) : [],
      supportedParameters: f.supportedParameters ? strings(getPath(entry, f.supportedParameters)) : [],
      toolsFlag: f.toolsFlag ? bool(getPath(entry, f.toolsFlag)) : null,
      visionFlag: f.visionFlag ? bool(getPath(entry, f.visionFlag)) : null,
      reasoningFlag: f.reasoningFlag ? bool(getPath(entry, f.reasoningFlag)) : null
    })
  }
  return out
}

/** The list URL with credential placeholders filled (`vars` from `resolveKey`). */
export function modelsUrl(spec: ModelsSpec, baseUrl: string, vars: Record<string, string> = {}): string {
  return fillUrl(spec.url ?? `${baseUrl.replace(/\/$/, '')}/models`, vars)
}

/** Request headers for the list call; the key goes where the spec says. */
export function modelsHeaders(spec: ModelsSpec, key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (key && spec.auth !== 'none') {
    if (spec.authHeader) headers[spec.authHeader] = key
    else headers['Authorization'] = `Bearer ${key}`
  }
  return headers
}
