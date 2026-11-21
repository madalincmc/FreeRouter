import { describe, expect, it } from 'vitest'
import type { ModelView, ProviderView } from '@shared/ipc'
import { diversify, rank, type Candidate } from '@core/routing/candidates'
import { ChainStore } from '@core/routing/chains'
import { HealthTracker } from '@core/routing/health'
import { estimateTokens, parseModelField, requestNeeds, UnknownModelError } from '@core/routing/intent'
import { counterKey, QuotaTracker } from '@core/routing/quota'
import { readSse } from '@core/routing/sse'
import { DEFAULT_ROUTER_CONFIG as CFG } from '@core/routing/types'
import { memoryDb } from '../helpers'

const providers = new Set(['groq', 'openrouter'])

describe('parseModelField', () => {
  it('maps the PRD §6 model values', () => {
    expect(parseModelField('auto', providers)).toEqual({ kind: 'auto', profile: null })
    expect(parseModelField(undefined, providers)).toEqual({ kind: 'auto', profile: null })
    expect(parseModelField('auto:coding', providers)).toEqual({ kind: 'auto', profile: 'coding' })
    expect(parseModelField('auto:long', providers)).toEqual({ kind: 'auto', profile: 'long' })
    expect(parseModelField('groq/llama-3.3-70b-versatile', providers)).toEqual({ kind: 'pinned', modelId: 'groq/llama-3.3-70b-versatile' })
    expect(parseModelField('openrouter/meta-llama/llama-3.3-70b-instruct:free', providers)).toEqual({
      kind: 'pinned',
      modelId: 'openrouter/meta-llama/llama-3.3-70b-instruct:free'
    })
    expect(parseModelField('chain:work', providers)).toEqual({ kind: 'chain', name: 'work' })
  })

  it('rejects unknown values', () => {
    for (const bad of ['gpt-4o', 'auto:turbo', 'acme/model', 'chain:']) {
      expect(() => parseModelField(bad, providers)).toThrow(UnknownModelError)
    }
  })
})

describe('requestNeeds', () => {
  const user = (content: string) => ({ model: 'auto', messages: [{ role: 'user' as const, content }] })

  it('infers profiles: tools → agentic, long → long, code → coding, else general', () => {
    expect(requestNeeds({ ...user('hi'), tools: [{ type: 'function' }] }, null, CFG).profile).toBe('agentic')
    expect(requestNeeds(user('x'.repeat(4 * 40_000)), null, CFG).profile).toBe('long')
    expect(requestNeeds(user('Why does this ```ts\nconst a = 1\n``` fail?'), null, CFG).profile).toBe('coding')
    expect(requestNeeds(user('Refactor src/app.py please'), null, CFG).profile).toBe('coding')
    expect(requestNeeds(user('Write a haiku about autumn'), null, CFG).profile).toBe('general')
  })

  it('tool_choice none means no tools; forced profiles win; coding+tools becomes agentic', () => {
    expect(requestNeeds({ ...user('hi'), tools: [{}], tool_choice: 'none' }, null, CFG).tools).toBe(false)
    expect(requestNeeds(user('```code```'), 'fast', CFG).profile).toBe('fast')
    expect(requestNeeds({ ...user('hi'), tools: [{}] }, 'coding', CFG).profile).toBe('agentic')
  })

  it('detects vision and JSON needs', () => {
    const n = requestNeeds(
      {
        model: 'auto',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
        response_format: { type: 'json_object' }
      },
      null,
      CFG
    )
    expect(n).toMatchObject({ vision: true, json: true })
  })

  it('estimates tokens at ~4 chars each, counting tools', () => {
    expect(estimateTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })).toBe(104)
    expect(estimateTokens({ messages: [], tools: [{ a: 'x'.repeat(398) }] })).toBeGreaterThan(100)
  })
})

function model(id: string, o: Partial<ModelView> = {}): ModelView {
  const [providerId] = id.split('/')
  return {
    id,
    providerId: providerId!,
    modelId: id.slice(providerId!.length + 1),
    displayName: id,
    isFree: true,
    isNew: false,
    enabled: true,
    tags: ['tools'],
    quality: { general: 60, coding: 60, reasoning: 60, tools: 60 },
    qualityOverridden: [],
    contextWindow: 131072,
    maxOutput: null,
    supportedParameters: [],
    inputModalities: [],
    state: 'healthy',
    cooldownUntil: null,
    lastError: null,
    p50LatencyMs: null,
    lastTestedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    ...o
  }
}

function provider(id: string, o: Partial<ProviderView> = {}): ProviderView {
  return {
    id,
    name: id,
    baseUrl: 'https://x',
    keyUrl: 'https://x',
    docsUrl: 'https://x',
    termsUrl: 'https://x',
    enabled: true,
    mayTrainOnData: false,
    limitScope: 'organization',
    keyRotation: true,
    notes: '',
    defaultLimits: {},
    limitOverrides: {},
    keys: [{ id: `${id}-k`, providerId: id, label: '', masked: '…', status: 'valid', enabled: true, createdAt: 0, lastOkAt: 0 }],
    ...o
  }
}

describe('rank', () => {
  const base = () => ({
    needs: requestNeeds({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, null, CFG),
    chains: () => undefined,
    quota: new QuotaTracker(memoryDb()),
    health: new HealthTracker(),
    cfg: CFG,
    opts: {}
  })

  it('diversifies: top 5, at most 2 per provider', () => {
    const models = [
      ...[90, 89, 88, 87].map((q, i) => model(`a/m${i}`, { quality: { general: q } })),
      ...[70, 69].map((q, i) => model(`b/m${i}`, { quality: { general: q } })),
      model('c/m0', { quality: { general: 50 } })
    ]
    const r = rank({ ...base(), strategy: { kind: 'auto', profile: null }, models, providers: ['a', 'b', 'c'].map((p) => provider(p)) })
    expect(r.candidates.map((c) => c.model.id)).toEqual(['a/m0', 'a/m1', 'b/m0', 'b/m1', 'c/m0'])
  })

  it('excludes paid, disabled, gone, cooling and keyless models with reasons', () => {
    const models = [
      model('a/paid', { isFree: false }),
      model('a/off', { enabled: false }),
      model('a/gone', { state: 'gone' }),
      model('a/cool', { state: 'cooling_down' }),
      model('b/nokey')
    ]
    const r = rank({ ...base(), strategy: { kind: 'auto', profile: null }, models, providers: [provider('a'), provider('b', { keys: [] })] })
    expect(r.candidates).toEqual([])
    expect(Object.fromEntries(r.excluded.map((e) => [e.id, e.reason]))).toEqual({
      'a/paid': 'not free',
      'a/off': 'disabled',
      'a/gone': 'gone',
      'a/cool': 'cooling down',
      'b/nokey': 'no usable key'
    })
  })

  it('degraded models are still eligible but score lower via reliability', () => {
    const h = new HealthTracker()
    for (let i = 0; i < 5; i++) h.record('a/flaky', false)
    const r = rank({
      ...base(),
      health: h,
      strategy: { kind: 'auto', profile: null },
      models: [model('a/flaky', { state: 'degraded', quality: { general: 80 } }), model('b/steady', { quality: { general: 75 } })],
      providers: [provider('a'), provider('b')]
    })
    expect(r.candidates.map((c) => c.model.id)).toEqual(['b/steady', 'a/flaky'])
  })

  it('JSON mode excludes models known not to support response_format', () => {
    const needs = requestNeeds({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } }, null, CFG)
    const r = rank({
      ...base(),
      needs,
      strategy: { kind: 'auto', profile: null },
      models: [model('a/known-no', { supportedParameters: ['tools'] }), model('a/known-yes', { supportedParameters: ['response_format'] }), model('a/unknown')],
      providers: [provider('a')]
    })
    expect(r.candidates.map((c) => c.model.id).sort()).toEqual(['a/known-yes', 'a/unknown'])
  })

  it('diversify keeps order and respects limits', () => {
    const c = (p: string, i: number) => ({ provider: { id: p }, model: { id: `${p}/${i}` } }) as unknown as Candidate
    expect(diversify([c('a', 1), c('a', 2), c('a', 3), c('b', 1)], 3, 2).map((x) => x.model.id)).toEqual(['a/1', 'a/2', 'b/1'])
  })
})

describe('QuotaTracker', () => {
  it('uses a sliding minute window and a persisted UTC day', () => {
    const db = memoryDb()
    let now = Date.UTC(2026, 10, 20, 12, 0, 0)
    const q = new QuotaTracker(db, () => now)
    const k = counterKey('key1', 'groq/m', false)
    q.recordRequest(k)
    q.recordRequest(k)
    expect(q.check(k, { rpm: 2 }).allowed).toBe(false)
    now += 61_000
    expect(q.check(k, { rpm: 2 })).toEqual({ allowed: true, headroom: 1 })
    expect(q.check(k, { rpd: 2 }).allowed).toBe(false)

    // A fresh tracker (app restart) still sees today's usage, but not yesterday's.
    const q2 = new QuotaTracker(db, () => now)
    expect(q2.usageToday(k).requests).toBe(2)
    now += 24 * 3600_000
    expect(q2.usageToday(k).requests).toBe(0)
  })

  it('reports headroom as the tightest remaining share', () => {
    const q = new QuotaTracker(memoryDb())
    const k = counterKey('k', 'm', false)
    q.recordRequest(k)
    expect(q.check(k, { rpm: 4, rpd: 100 }).headroom).toBe(0.75)
  })

  it('counts tokens against TPM including the estimate for the next request', () => {
    const q = new QuotaTracker(memoryDb())
    const k = counterKey('k', 'm', false)
    q.recordRequest(k, 800)
    q.recordTokens(k, 150)
    expect(q.check(k, { tpm: 1000 }, 40).allowed).toBe(true)
    expect(q.check(k, { tpm: 1000 }, 60).allowed).toBe(false)
    expect(q.check(k, { rpm: 2 }).allowed).toBe(true) // tokens are not requests
  })

  it('account-wide counters share one key across models', () => {
    expect(counterKey('k', 'openrouter/a', true)).toBe(counterKey('k', 'openrouter/b', true))
    expect(counterKey('k', 'groq/a', false)).not.toBe(counterKey('k', 'groq/b', false))
  })

  it('header hints block until their reset', () => {
    let now = 1_000_000
    const q = new QuotaTracker(memoryDb(), () => now)
    const h = new Map([
      ['x-ratelimit-remaining-requests', '0'],
      ['x-ratelimit-reset-requests', '30s']
    ])
    q.recordHeaders('k|m', { get: (n) => h.get(n) ?? null })
    expect(q.check('k|m', {}).allowed).toBe(false)
    now += 31_000
    expect(q.check('k|m', {}).allowed).toBe(true)
  })
})

describe('readSse', () => {
  const stream = (...parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p))
        c.close()
      }
    })
  const collect = async (s: ReadableStream<Uint8Array>) => {
    const out: string[] = []
    for await (const d of readSse(s)) out.push(d)
    return out
  }

  it('handles split events, CRLF, comments and [DONE]', async () => {
    expect(await collect(stream(': ping\r\n\r\ndata: {"a"', ':1}\r\n\r\ndata: {"b":2}\n\nevent: x\ndata: [DONE]\n\ndata: {"late":1}\n\n'))).toEqual([
      '{"a":1}',
      '{"b":2}'
    ])
  })

  it('yields a trailing event without a final blank line', async () => {
    expect(await collect(stream('data: {"z":1}'))).toEqual(['{"z":1}'])
  })
})

describe('ChainStore', () => {
  it('saves, updates, lists and deletes', () => {
    const s = new ChainStore(memoryDb())
    s.save('work', ['a/1', 'b/2'])
    s.save('work', ['b/2'])
    expect(s.get('work')).toEqual(['b/2'])
    expect(s.list().map((c) => c.name)).toEqual(['work'])
    expect(() => s.save('bad name!', [])).toThrow()
    expect(s.delete('work')).toBe(true)
    expect(s.get('work')).toBeUndefined()
  })
})
