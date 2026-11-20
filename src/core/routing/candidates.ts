import type { KeyView, Limits, ModelView, ProviderView } from '@shared/ipc'
import type { HealthTracker } from './health'
import type { RequestNeeds } from './intent'
import { counterKey, type QuotaTracker } from './quota'
import { QUALITY_FOR_PROFILE, type RouteOptions, type RouterConfig, type Strategy } from './types'

export interface Candidate {
  model: ModelView
  provider: ProviderView
  key: KeyView
  counterKey: string
  score: number
  breakdown: { quality: number; reliability: number; speed: number; headroom: number }
}

export interface Ranking {
  candidates: Candidate[]
  excluded: { id: string; reason: string }[]
}

export class RoutingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message)
    this.name = 'RoutingError'
  }
}

export interface RankInput {
  strategy: Strategy
  needs: RequestNeeds
  models: ModelView[]
  providers: ProviderView[]
  chains: (name: string) => string[] | undefined
  quota: QuotaTracker
  health: HealthTracker
  cfg: RouterConfig
  opts: Pick<RouteOptions, 'privateMode' | 'minContext'>
  /** Models/keys ruled out earlier in this request (400s, invalid keys). */
  excludeModels?: Set<string>
  excludeKeys?: Set<string>
  /** Round-robin offset per provider (only used where the provider allows rotation). */
  rotation?: Map<string, number>
}

export function effectiveLimits(p: ProviderView): Limits {
  return { ...p.defaultLimits, ...p.limitOverrides }
}

function usableKeys(p: ProviderView, exclude: Set<string> | undefined): KeyView[] {
  const keys = p.keys.filter((k) => k.enabled && k.status !== 'invalid' && !exclude?.has(k.id))
  // Prefer verified keys.
  return [...keys.filter((k) => k.status === 'valid'), ...keys.filter((k) => k.status !== 'valid')]
}

/** First key (in rotation order where allowed) whose quota still has room for this model. */
function pickKey(
  m: ModelView,
  p: ProviderView,
  input: RankInput
): { key: KeyView; counterKey: string; headroom: number } | { reason: string } {
  let keys = usableKeys(p, input.excludeKeys)
  if (keys.length === 0) return { reason: 'no usable key' }
  if (p.keyRotation && keys.length > 1) {
    const offset = (input.rotation?.get(p.id) ?? 0) % keys.length
    keys = [...keys.slice(offset), ...keys.slice(0, offset)]
  }
  const limits = effectiveLimits(p)
  let lastReason = 'quota'
  for (const key of keys) {
    const ck = counterKey(key.id, m.id, p.limitScope === 'account')
    const q = input.quota.check(ck, limits, input.needs.promptTokens)
    if (q.allowed) return { key, counterKey: ck, headroom: q.headroom }
    lastReason = q.reason ?? 'quota'
  }
  return { reason: lastReason }
}

/** Hard requirements; returns a reason when the model can't take this request. */
function rejectReason(m: ModelView, p: ProviderView | undefined, input: RankInput, strict: boolean): string | null {
  const { needs, cfg, opts } = input
  if (!p) return 'unknown provider'
  if (input.excludeModels?.has(m.id)) return 'excluded earlier in this request'
  if (!p.enabled) return 'provider disabled'
  if (!m.isFree) return 'not free'
  if (!m.enabled) return 'disabled'
  if (m.state !== 'healthy' && m.state !== 'degraded') return m.state.replace('_', ' ')
  if (opts.privateMode && p.mayTrainOnData) return 'private mode: provider may train on data'

  const ctx = m.contextWindow ?? cfg.unknownContextWindow
  if (needs.promptTokens > ctx * cfg.contextFraction) return `context too small (${ctx})`
  if (opts.minContext && ctx < opts.minContext) return `context below x-fr-min-context (${ctx})`
  if (needs.profile === 'long' && strict && !m.tags.includes('long_context')) return 'not long-context'

  if (needs.tools) {
    if (!m.tags.includes('tools')) return 'no tool support'
    if (strict && (m.quality.tools ?? 0) < cfg.minToolsQuality) return `tool quality below ${cfg.minToolsQuality}`
  }
  if (needs.vision && !m.tags.includes('vision')) return 'no vision support'
  if (needs.json && m.supportedParameters.length > 0 && !m.supportedParameters.includes('response_format')) {
    return 'no JSON mode'
  }
  return null
}

function score(m: ModelView, headroom: number, input: RankInput): Candidate['breakdown'] & { total: number } {
  const profiles = QUALITY_FOR_PROFILE[input.needs.profile]
  const quality = profiles.reduce((s, p) => s + (m.quality[p] ?? 50), 0) / profiles.length / 100
  const reliability = input.health.reliability(m.id)
  // 1 s → 0.5, 3 s → 0.25; unknown counts as average.
  const speed = m.p50LatencyMs === null ? 0.5 : 1000 / (1000 + m.p50LatencyMs)
  let w = input.cfg.weights
  if (input.needs.profile === 'fast') w = { quality: 0.3, reliability: 0.2, speed: 0.4, headroom: 0.1 }
  const total = 100 * (w.quality * quality + w.reliability * reliability + w.speed * speed + w.headroom * headroom)
  return { quality, reliability, speed, headroom, total }
}

function evaluate(m: ModelView, p: ProviderView | undefined, input: RankInput, strict: boolean): Candidate | string {
  const reason = rejectReason(m, p, input, strict)
  if (reason) return reason
  const k = pickKey(m, p!, input)
  if ('reason' in k) return k.reason
  const s = score(m, k.headroom, input)
  return {
    model: m,
    provider: p!,
    key: k.key,
    counterKey: k.counterKey,
    score: Math.round(s.total * 10) / 10,
    breakdown: { quality: s.quality, reliability: s.reliability, speed: s.speed, headroom: s.headroom }
  }
}

/** Top N by score, never more than `maxPerProvider` from one provider (PRD §6 "Diversify"). */
export function diversify(sorted: Candidate[], topN: number, maxPerProvider: number): Candidate[] {
  const out: Candidate[] = []
  const per = new Map<string, number>()
  for (const c of sorted) {
    if (out.length >= topN) break
    const n = per.get(c.provider.id) ?? 0
    if (n >= maxPerProvider) continue
    per.set(c.provider.id, n + 1)
    out.push(c)
  }
  return out
}

/** Filter → score → diversify (PRD §6), shaped by the strategy. */
export function rank(input: RankInput): Ranking {
  const providers = new Map(input.providers.map((p) => [p.id, p]))
  const excluded: Ranking['excluded'] = []
  const consider = (m: ModelView, strict: boolean): Candidate | null => {
    const r = evaluate(m, providers.get(m.providerId), input, strict)
    if (typeof r === 'string') {
      excluded.push({ id: m.id, reason: r })
      return null
    }
    return r
  }
  const autoList = (skip?: string): Candidate[] =>
    diversify(
      input.models
        .filter((m) => m.id !== skip)
        .map((m) => consider(m, true))
        .filter((c): c is Candidate => c !== null)
        .sort((a, b) => b.score - a.score),
      input.cfg.topN,
      input.cfg.maxPerProvider
    )

  const s = input.strategy
  if (s.kind === 'auto') return { candidates: autoList(), excluded }

  if (s.kind === 'pinned') {
    const pinned = input.models.find((m) => m.id === s.modelId)
    if (!pinned) throw new RoutingError(`Model ${s.modelId} is not in the registry`, 404, 'model_not_found')
    // A pinned model skips the "quality" gates (tool score, long-context tag) but not hard ones.
    const first = consider(pinned, false)
    const rest = input.cfg.allowFallbackWhenPinned ? autoList(pinned.id) : []
    return { candidates: first ? [first, ...rest] : rest, excluded }
  }

  const ids = input.chains(s.name)
  if (!ids) throw new RoutingError(`Unknown chain "${s.name}"`, 404, 'chain_not_found')
  const byId = new Map(input.models.map((m) => [m.id, m]))
  const candidates: Candidate[] = []
  for (const id of ids) {
    const m = byId.get(id)
    if (!m) {
      excluded.push({ id, reason: 'not in registry' }) // chains skip missing entries (PRD §15)
      continue
    }
    const c = consider(m, false)
    if (c) candidates.push(c)
  }
  return { candidates, excluded }
}
