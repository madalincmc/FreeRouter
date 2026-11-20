import { describe, expect, it } from 'vitest'
import { bundledCatalog } from '@core/providers/catalog'
import { modelsHeaders, modelsUrl, parseModelList } from '@core/registry/discover'
import { cerebrasModels, geminiModels, groqModels, mistralModels, nvidiaModels, openrouterModels } from '../fixtures/models'

const spec = (id: string) => bundledCatalog.providers.find((p) => p.id === id)!.models
const ids = (list: { modelId: string }[]) => list.map((m) => m.modelId)

describe('parseModelList', () => {
  it('OpenRouter: detects free by :free suffix or zero pricing, drops non-text generators', () => {
    const list = parseModelList(spec('openrouter'), openrouterModels)
    expect(ids(list)).toEqual([
      'inclusionai/ling-3.2-flash:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'openrouter/free',
      'anthropic/claude-fable-5.2',
      'meta-llama/llama-3.3-70b-instruct:free'
    ])
    const free = Object.fromEntries(list.map((m) => [m.modelId, m.isFree]))
    expect(free['anthropic/claude-fable-5.2']).toBe(false)
    expect(free['openrouter/free']).toBe(true)
    const ling = list[0]!
    expect(ling).toMatchObject({
      name: 'inclusionAI: Ling 3.2 Flash (free)',
      contextWindow: 1048576,
      maxOutput: 262144,
      inputModalities: ['text', 'image']
    })
    expect(ling.supportedParameters).toContain('tools')
    expect(list[1]!.maxOutput).toBeNull()
  })

  it('Groq: everything is free; drops audio, guard and inactive models', () => {
    const list = parseModelList(spec('groq'), groqModels)
    expect(ids(list)).toEqual(['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'])
    expect(list.every((m) => m.isFree)).toBe(true)
    expect(list[0]).toMatchObject({ contextWindow: 131072, maxOutput: 32768 })
  })

  it('Gemini (native API): strips models/, requires generateContent, drops embeddings, TTS, agents and media models', () => {
    const list = parseModelList(spec('gemini'), geminiModels)
    expect(ids(list)).toEqual(['gemini-2.5-flash'])
    // Checked live 2026-11-20: Interactions-API-only agents and music/image generators aren't chat models.
    for (const id of ['deep-research-max-preview-04-2026', 'antigravity-preview-latest', 'lyria-3.5', 'nano-banana-pro-preview']) {
      const extra = { models: [{ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] }] }
      expect(parseModelList(spec('gemini'), extra)).toEqual([])
    }
    expect(list[0]).toMatchObject({ name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxOutput: 65536, reasoningFlag: true })
  })

  it('Cerebras: ids only', () => {
    const list = parseModelList(spec('cerebras'), cerebrasModels)
    expect(ids(list)).toEqual(['gpt-oss-120b', 'llama3.1-8b'])
    expect(list[0]!.contextWindow).toBeNull()
  })

  it('Mistral: reads capability flags and skips non-chat models', () => {
    const list = parseModelList(spec('mistral'), mistralModels)
    expect(ids(list)).toEqual(['mistral-large-latest', 'codestral-latest'])
    expect(list[0]).toMatchObject({ toolsFlag: true, visionFlag: false, contextWindow: 131072 })
  })

  it('NVIDIA: public list; drops embeddings, guards, safety, detectors and base code models', () => {
    const list = parseModelList(spec('nvidia'), nvidiaModels)
    expect(ids(list)).toEqual(['google/gemma-4-31b-it', 'moonshotai/kimi-k3.1-pro', 'nvidia/nemotron-3-ultra-550b-a55b', 'z-ai/glm-5.3-flash'])
    expect(list.every((m) => m.isFree)).toBe(true)
    expect(list[1]).toMatchObject({ contextWindow: 1048576, toolsFlag: true, reasoningFlag: true })
    // Most entries carry no metadata: unknown, not "no tools".
    expect(list[0]).toMatchObject({ contextWindow: null, toolsFlag: null })
    expect(modelsHeaders(spec('nvidia'), 'nvapi-x')['Authorization']).toBeUndefined()
  })

  it('throws on an unexpected shape instead of returning nothing', () => {
    expect(() => parseModelList(spec('groq'), { error: 'nope' })).toThrow(/no array/)
  })

  it('dedupes repeated ids', () => {
    const dup = { data: [groqModels.data[0], groqModels.data[0]] }
    expect(parseModelList(spec('groq'), dup)).toHaveLength(1)
  })
})

describe('models request', () => {
  it('uses the profile URL or defaults to baseUrl/models', () => {
    expect(modelsUrl(spec('groq'), 'https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1/models')
    expect(modelsUrl(spec('gemini'), 'x')).toContain('/v1beta/models?pageSize=')
  })

  it('puts the key where the spec says', () => {
    expect(modelsHeaders(spec('groq'), 'gsk_x')['Authorization']).toBe('Bearer gsk_x')
    const g = modelsHeaders(spec('gemini'), 'AIza_x')
    expect(g['x-goog-api-key']).toBe('AIza_x')
    expect(g['Authorization']).toBeUndefined()
    expect(modelsHeaders(spec('openrouter'), 'sk-or-x')['Authorization']).toBeUndefined()
  })
})
