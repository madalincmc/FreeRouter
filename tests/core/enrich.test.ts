import { describe, expect, it } from 'vitest'
import { bundledCatalog } from '@core/providers/catalog'
import { parseModelList, type DiscoveredModel } from '@core/registry/discover'
import { baselineQuality, bundledSeed, enrich, paramsBillions, parseSeed } from '@core/registry/enrich'
import { cerebrasModels, groqModels, openrouterModels } from '../fixtures/models'

const spec = (id: string) => bundledCatalog.providers.find((p) => p.id === id)!.models
const bare = (modelId: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
  modelId,
  name: null,
  isFree: true,
  contextWindow: null,
  maxOutput: null,
  inputModalities: [],
  supportedParameters: [],
  toolsFlag: null,
  visionFlag: null,
  reasoningFlag: null,
  ...extra
})

describe('seed', () => {
  it('bundled seed parses and every pattern compiles', () => {
    expect(bundledSeed.length).toBeGreaterThan(20)
  })

  it('rejects scores outside 0–100', () => {
    expect(() =>
      parseSeed({ version: 1, note: '', families: [{ match: 'x', tags: [], quality: { general: 101 } }] })
    ).toThrow()
  })
})

describe('enrich', () => {
  it('applies seed families across providers despite different ids', () => {
    const groq = parseModelList(spec('groq'), groqModels).map((m) => enrich(m, spec('groq')))
    const cerebras = parseModelList(spec('cerebras'), cerebrasModels).map((m) => enrich(m, spec('cerebras')))
    const gptOssGroq = groq.find((m) => m.modelId === 'openai/gpt-oss-120b')!
    const gptOssCerebras = cerebras.find((m) => m.modelId === 'gpt-oss-120b')!
    expect(gptOssGroq.quality).toEqual(gptOssCerebras.quality)
    expect(gptOssGroq.tags).toEqual(expect.arrayContaining(['coding', 'reasoning', 'tools', 'fast', 'long_context']))
    // Seed fills in a context window Cerebras doesn't report.
    expect(gptOssCerebras.contextWindow).toBe(131072)
  })

  it('derives tags from provider metadata for unknown models', () => {
    const [ling] = parseModelList(spec('openrouter'), openrouterModels).map((m) => enrich(m, spec('openrouter')))
    expect(ling!.tags).toEqual(['reasoning', 'tools', 'vision', 'long_context', 'fast'])
    expect(ling!.displayName).toBe('inclusionAI: Ling 3.2 Flash (free)')
  })

  it('scores unknown models from parameter count', () => {
    expect(paramsBillions('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(550)
    expect(paramsBillions('liquid/lfm-3-1.7b:free')).toBe(1.7)
    expect(paramsBillions('mystery-model')).toBeNull()
    expect(baselineQuality('nemotron-3-ultra-550b-a55b')).toBe(74)
    expect(baselineQuality('lfm-3-1.7b')).toBe(40)
    expect(baselineQuality('mystery-model')).toBe(55)
  })

  it('gives tool quality only to tool-capable models, below the 60 threshold when unknown and small', () => {
    const noTools = enrich(bare('mystery-model'), spec('cerebras'))
    expect(noTools.quality.tools).toBe(0)
    const small = enrich(bare('mystery-12b', { supportedParameters: ['tools'] }), spec('openrouter'))
    expect(small.quality.tools).toBeLessThan(60)
    const big = enrich(bare('mystery-400b', { supportedParameters: ['tools'] }), spec('openrouter'))
    expect(big.quality.tools).toBeGreaterThanOrEqual(60)
  })

  it('tags coding and reasoning models by name', () => {
    expect(enrich(bare('acme/super-coder-30b'), spec('openrouter')).tags).toContain('coding')
    expect(enrich(bare('acme/thing-r1'), spec('openrouter')).tags).toContain('reasoning')
    expect(enrich(bare('acme/encoder-7b'), spec('openrouter')).tags).not.toContain('coding')
  })

  it('makes a readable display name when the provider has none', () => {
    expect(enrich(bare('meta-llama/llama-3.3-70b-instruct:free'), spec('openrouter')).displayName).toBe(
      'llama 3.3 70b instruct'
    )
  })
})
