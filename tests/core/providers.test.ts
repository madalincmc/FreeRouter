import { describe, expect, it } from 'vitest'
import { bundledCatalog, parseCatalog } from '@core/providers/catalog'
import { cleanLimits, effectiveLimits, ProviderStore } from '@core/providers/store'
import { memoryDb } from '../helpers'

describe('provider catalog', () => {
  it('contains exactly the six MVP providers', () => {
    expect(bundledCatalog.providers.map((p) => p.id)).toEqual([
      'openrouter',
      'groq',
      'gemini',
      'cerebras',
      'mistral',
      'github'
    ])
  })

  it('uses https everywhere', () => {
    for (const p of bundledCatalog.providers) {
      for (const url of [p.baseUrl, p.keyUrl, p.docsUrl, p.validation.url]) expect(url).toMatch(/^https:\/\//)
    }
  })

  it('rejects duplicate ids and unknown fields', () => {
    const p = bundledCatalog.providers[0]!
    expect(() => parseCatalog({ ...bundledCatalog, providers: [p, p] })).toThrow(/Duplicate/)
    expect(() => parseCatalog({ ...bundledCatalog, providers: [{ ...p, surprise: 1 }] })).toThrow()
  })

  it('marks OpenRouter limits as account-wide with no key rotation (PRD §6)', () => {
    const or = bundledCatalog.providers.find((p) => p.id === 'openrouter')!
    expect(or).toMatchObject({ limitScope: 'account', keyRotation: false, limits: { rpm: 20, rpd: 50 } })
  })
})

describe('ProviderStore', () => {
  it('seeds every provider enabled with no overrides', () => {
    const db = memoryDb()
    const store = new ProviderStore(db, bundledCatalog)
    store.seed()
    const list = store.list(() => [])
    expect(list).toHaveLength(6)
    expect(list.every((p) => p.enabled && Object.keys(p.limitOverrides).length === 0)).toBe(true)
    expect(db.prepare("SELECT may_train_on_data AS t FROM providers WHERE id = 'gemini'").get()).toEqual({ t: 1 })
  })

  it('re-seeding keeps user choices but refreshes catalog data', () => {
    const db = memoryDb()
    const store = new ProviderStore(db, bundledCatalog)
    store.seed()
    store.setEnabled('groq', false)
    store.setLimitOverrides('groq', { rpm: 15 })

    const renamed = {
      ...bundledCatalog,
      providers: bundledCatalog.providers.map((p) => (p.id === 'groq' ? { ...p, name: 'Groq Cloud' } : p))
    }
    const store2 = new ProviderStore(db, renamed)
    store2.seed()
    const groq = store2.list(() => []).find((p) => p.id === 'groq')!
    expect(groq).toMatchObject({ name: 'Groq Cloud', enabled: false, limitOverrides: { rpm: 15 } })
  })

  it('stores only meaningful overrides; blank means default', () => {
    const db = memoryDb()
    const store = new ProviderStore(db, bundledCatalog)
    store.seed()
    store.setLimitOverrides('cerebras', { rpm: 0, rpd: 500, tpm: undefined })
    const c = store.list(() => []).find((p) => p.id === 'cerebras')!
    expect(c.limitOverrides).toEqual({ rpd: 500 })
    expect(effectiveLimits(store.profile('cerebras')!, c.limitOverrides)).toEqual({ rpm: 30, tpd: 1_000_000, rpd: 500 })
  })

  it('rejects unknown providers', () => {
    const store = new ProviderStore(memoryDb(), bundledCatalog)
    expect(() => store.setEnabled('nope', true)).toThrow(/Unknown provider/)
  })

  it('cleanLimits drops non-positive and non-integer values', () => {
    expect(cleanLimits({ rpm: -1, rpd: 1.5, tpm: 100 })).toEqual({ tpm: 100 })
  })
})
