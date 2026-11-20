import { describe, expect, it } from 'vitest'
import { bundledCatalog } from '@core/providers/catalog'
import { ProviderStore } from '@core/providers/store'
import { parseModelList } from '@core/registry/discover'
import { enrich } from '@core/registry/enrich'
import { median, ModelRegistry, NEW_BADGE_MS } from '@core/registry/store'
import { memoryDb } from '../helpers'
import { groqModels } from '../fixtures/models'

const spec = bundledCatalog.providers.find((p) => p.id === 'groq')!.models
const groq = () => parseModelList(spec, groqModels).map((m) => enrich(m, spec))

function setup() {
  const db = memoryDb()
  new ProviderStore(db, bundledCatalog).seed()
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  return { db, clock, registry: new ModelRegistry(db, clock.now) }
}

describe('ModelRegistry.applySync', () => {
  it('inserts models on the initial sync without "new" badges', () => {
    const { registry } = setup()
    const diff = registry.applySync('groq', groq())
    expect(diff).toMatchObject({ total: 2, gone: [], returned: [] })
    expect(diff.added).toEqual(['groq/llama-3.3-70b-versatile', 'groq/openai/gpt-oss-120b'])
    expect(registry.list().every((m) => !m.isNew && m.state === 'healthy' && m.enabled)).toBe(true)
  })

  it('badges free models that appear after the first sync, for a week', () => {
    const { registry, clock } = setup()
    registry.applySync('groq', groq().slice(0, 1))
    registry.applySync('groq', groq())
    expect(registry.get('groq/openai/gpt-oss-120b')?.isNew).toBe(true)
    expect(registry.get('groq/llama-3.3-70b-versatile')?.isNew).toBe(false)
    clock.advance(NEW_BADGE_MS + 1)
    expect(registry.get('groq/openai/gpt-oss-120b')?.isNew).toBe(false)
  })

  it('marks a model gone after two consecutive missed syncs, and revives it when it returns', () => {
    const { registry } = setup()
    registry.applySync('groq', groq())
    const onlyLlama = groq().slice(0, 1)

    expect(registry.applySync('groq', onlyLlama).gone).toEqual([])
    expect(registry.get('groq/openai/gpt-oss-120b')?.state).toBe('healthy')

    expect(registry.applySync('groq', onlyLlama).gone).toEqual(['groq/openai/gpt-oss-120b'])
    expect(registry.get('groq/openai/gpt-oss-120b')?.state).toBe('gone')
    // Kept in history, not deleted.
    expect(registry.list()).toHaveLength(2)

    const back = registry.applySync('groq', groq())
    expect(back.returned).toEqual(['groq/openai/gpt-oss-120b'])
    expect(registry.get('groq/openai/gpt-oss-120b')?.state).toBe('healthy')
  })

  it('a single miss followed by a hit resets the counter', () => {
    const { registry } = setup()
    registry.applySync('groq', groq())
    registry.applySync('groq', groq().slice(0, 1))
    registry.applySync('groq', groq())
    registry.applySync('groq', groq().slice(0, 1))
    expect(registry.get('groq/openai/gpt-oss-120b')?.state).toBe('healthy')
  })

  it('keeps user choices (enabled, quality overrides) across syncs', () => {
    const { registry } = setup()
    registry.applySync('groq', groq())
    registry.setEnabled('groq/llama-3.3-70b-versatile', false)
    registry.setQualityOverride('groq/llama-3.3-70b-versatile', { coding: 90 })
    registry.applySync('groq', groq())
    const m = registry.get('groq/llama-3.3-70b-versatile')!
    expect(m.enabled).toBe(false)
    expect(m.quality.coding).toBe(90)
    expect(m.qualityOverridden).toEqual(['coding'])
    registry.setQualityOverride(m.id, { coding: null })
    expect(registry.get(m.id)!.quality.coding).toBe(62)
  })

  it('records sync failures without touching models', () => {
    const { registry } = setup()
    registry.applySync('groq', groq())
    registry.recordSyncFailure('groq', 'HTTP 503')
    const [status] = registry.syncStatus(['groq'])
    expect(status).toMatchObject({ lastError: 'HTTP 503', modelCount: 2, freeCount: 2 })
    expect(registry.list()).toHaveLength(2)
  })
})

describe('ModelRegistry live state', () => {
  it('tracks p50 latency over recent samples', () => {
    const { registry } = setup()
    registry.applySync('groq', groq())
    const id = 'groq/llama-3.3-70b-versatile'
    for (const ms of [300, 100, 200, 900]) registry.recordOutcome(id, { latencyMs: ms })
    expect(registry.get(id)!.p50LatencyMs).toBe(250)
  })

  it('an expired cooldown reads as healthy', () => {
    const { registry, clock } = setup()
    registry.applySync('groq', groq())
    const id = 'groq/llama-3.3-70b-versatile'
    registry.recordOutcome(id, { state: 'cooling_down', cooldownUntil: clock.now() + 60_000, error: '429' })
    expect(registry.get(id)!.state).toBe('cooling_down')
    clock.advance(60_001)
    expect(registry.get(id)!.state).toBe('healthy')
  })

  it('median handles odd, even and empty input', () => {
    expect(median([])).toBeNull()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(3)
  })
})
