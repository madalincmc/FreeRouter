import { z } from 'zod'
import type { CapabilityTag, Quality, QualityProfile } from '@shared/ipc'
import { CAPABILITY_TAGS, type ModelsSpec } from '../providers/catalog'
import type { DiscoveredModel } from './discover'
import seedJson from './seed.json'

const QualitySchema = z
  .object({
    general: z.number().min(0).max(100).optional(),
    coding: z.number().min(0).max(100).optional(),
    reasoning: z.number().min(0).max(100).optional(),
    tools: z.number().min(0).max(100).optional()
  })
  .strict()

const SeedSchema = z.object({
  version: z.number(),
  note: z.string(),
  families: z.array(
    z
      .object({
        match: z.string(),
        tags: z.array(z.enum(CAPABILITY_TAGS)),
        quality: QualitySchema,
        contextWindow: z.number().int().positive().optional()
      })
      .strict()
  )
})

export interface SeedFamily {
  match: RegExp
  tags: CapabilityTag[]
  quality: Quality
  contextWindow?: number
}

export function parseSeed(data: unknown): SeedFamily[] {
  return SeedSchema.parse(data).families.map((f) => ({ ...f, match: new RegExp(f.match, 'i') }))
}

export const bundledSeed: SeedFamily[] = parseSeed(seedJson)

export const QUALITY_PROFILES: QualityProfile[] = ['general', 'coding', 'reasoning', 'tools']

export interface EnrichedModel extends DiscoveredModel {
  displayName: string
  tags: CapabilityTag[]
  /** Seed or heuristic scores (user overrides are stored separately). */
  quality: Required<Quality>
}

/** Largest "<n>b" parameter count in a model id: `nemotron-3-ultra-550b-a55b` → 550. */
export function paramsBillions(modelId: string): number | null {
  const matches = [...modelId.toLowerCase().matchAll(/(\d+(?:\.\d+)?)b(?![a-z])/g)].map((m) => Number(m[1]))
  return matches.length ? Math.max(...matches) : null
}

/** Size-based baseline for models the seed doesn't know. Deliberately modest; users can edit. */
export function baselineQuality(modelId: string): number {
  const p = paramsBillions(modelId)
  if (p !== null) {
    if (p >= 300) return 74
    if (p >= 100) return 70
    if (p >= 50) return 66
    if (p >= 25) return 62
    if (p >= 10) return 56
    if (p >= 5) return 48
    return 40
  }
  const id = modelId.toLowerCase()
  if (/(nano|tiny|lite|mini|small)/.test(id)) return 50
  if (/(ultra|large|pro|max)/.test(id)) return 62
  return 55
}

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))

function prettify(modelId: string): string {
  const last = modelId.split('/').pop() ?? modelId
  return last.replace(/:free$/, '').replace(/[-_]/g, ' ')
}

export function enrich(m: DiscoveredModel, spec: ModelsSpec, seed: SeedFamily[] = bundledSeed): EnrichedModel {
  const id = m.modelId.toLowerCase()
  const family = seed.find((f) => f.match.test(m.modelId))
  const tags = new Set<CapabilityTag>([...(family?.tags ?? []), ...(spec.defaultTags ?? [])])
  const contextWindow = m.contextWindow ?? family?.contextWindow ?? null

  if (m.supportedParameters.includes('tools') || m.toolsFlag === true) tags.add('tools')
  if (m.inputModalities.includes('image') || m.visionFlag === true) tags.add('vision')
  if (
    m.supportedParameters.includes('reasoning') ||
    m.reasoningFlag === true ||
    /(^|[-/_.])(r1|reason|reasoning|thinking|qwq|magistral)([-/_.:]|$)/.test(id)
  ) {
    tags.add('reasoning')
  }
  // `coder` must start a name segment so "encoder" doesn't count.
  if (/(^|[-/_.])coder|codestral|devstral|(^|[-/_.])code([-/_.:]|$)/.test(id)) tags.add('coding')
  if (contextWindow !== null && contextWindow >= 128_000) tags.add('long_context')
  if (/(flash|lite|instant|lightning|nano|turbo)/.test(id)) tags.add('fast')

  const base = family?.quality.general ?? baselineQuality(m.modelId)
  const quality: Required<Quality> = {
    general: clamp(base),
    coding: clamp(family?.quality.coding ?? base + (tags.has('coding') ? 6 : -4)),
    reasoning: clamp(family?.quality.reasoning ?? base + (tags.has('reasoning') ? 5 : -3)),
    // Unknown tool-callers start below the PRD §8 threshold of 60 unless they're large.
    tools: tags.has('tools') ? clamp(family?.quality.tools ?? base - 2) : 0
  }

  return {
    ...m,
    contextWindow,
    displayName: m.name ?? prettify(m.modelId),
    tags: CAPABILITY_TAGS.filter((t) => tags.has(t)),
    quality
  }
}
