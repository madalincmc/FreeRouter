import { afterEach, describe, expect, it } from 'vitest'
import { makeHarness, type Harness, type HarnessOptions } from '../routerHarness'

let h: Harness
const setup = async (o?: HarnessOptions) => (h = await makeHarness(o))
afterEach(async () => h?.stop())

describe('Router – happy path', () => {
  it('streams the top-ranked model and logs metadata only', async () => {
    await setup()
    const r = await h.run({ messages: [{ role: 'user', content: 'Say hello' }] })
    expect(r.error).toBeUndefined()
    expect(r.start).toMatchObject({ provider: 'fa', model: 'fa/big-400b', modelId: 'big-400b' })
    expect(r.text).toBe('Hello from big-400b')
    expect(r.done).toMatchObject({ provider: 'fa', usage: { prompt_tokens: 11, estimated: false } })
    expect(r.done!.attempts).toEqual([expect.objectContaining({ model: 'fa/big-400b', outcome: 'ok' })])

    const call = h.fake.callsTo('fa')[0]!
    expect(call.body).toMatchObject({ model: 'big-400b', stream: true })
    expect(call.headers.authorization).toBe('Bearer sk-fake-fa-0-0123456789')

    const [log] = h.requestLog.recent()
    expect(log).toMatchObject({ status: 'ok', requestedModel: 'auto', chosenModel: 'fa/big-400b', source: 'gateway' })
    expect(JSON.stringify(log)).not.toContain('Say hello')
    expect(h.registry.get('fa/big-400b')!.p50LatencyMs).not.toBeNull()
  })

  it('handles providers that ignore stream:true and return JSON', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'json', text: 'plain json' })
    const r = await h.run()
    expect(r.text).toBe('plain json')
    expect(r.done?.usage.completion_tokens).toBe(3)
  })

  it('estimates usage when the provider sends none', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'ok', text: 'twelve chars', usage: false })
    const r = await h.run()
    expect(r.done!.usage).toMatchObject({ completion_tokens: 3, estimated: true })
  })
})

describe('Router – failover before the first token (PRD §6, §14)', () => {
  it('429 on the top model: the next candidate answers, no visible error, top model cools down', async () => {
    await setup()
    const before = Date.now()
    h.fake.script('fa', 'big-400b', { kind: 'status', status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'Rate limit reached' } } })
    const r = await h.run()
    expect(r.error).toBeUndefined()
    expect(r.start!.model).toBe('fb/alpha-120b')
    expect(r.done!.attempts.map((a) => [a.model, a.outcome, a.failure])).toEqual([
      ['fa/big-400b', 'failed', 'rate_limited'],
      ['fb/alpha-120b', 'ok', undefined]
    ])
    const top = h.registry.get('fa/big-400b')!
    expect(top.state).toBe('cooling_down')
    expect(top.cooldownUntil).toBeGreaterThanOrEqual(before + 29_000)
    expect(top.lastError).toBe('Rate limit reached')

    // While cooling down it isn't even tried.
    const again = await h.run()
    expect(again.done!.attempts[0]!.model).toBe('fb/alpha-120b')
  })

  it('a daily cap marks quota_exhausted', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'status', status: 429, body: { error: { message: 'Rate limit exceeded: free-models-per-day' } } })
    await h.run()
    expect(h.registry.get('fa/big-400b')!.state).toBe('quota_exhausted')
  })

  it('5xx degrades; three in a row cool the model down for 5 minutes', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'status', status: 503 })
    expect((await h.run()).start!.model).toBe('fb/alpha-120b')
    expect(h.registry.get('fa/big-400b')!.state).toBe('degraded')
    // A degraded model drops in the ranking, so pin it to force the next two attempts.
    await h.run({ model: 'fa/big-400b' })
    const t = Date.now()
    await h.run({ model: 'fa/big-400b' })
    const m = h.registry.get('fa/big-400b')!
    expect(m.state).toBe('cooling_down')
    expect(m.cooldownUntil).toBeGreaterThanOrEqual(t + 4.9 * 60_000)
  })

  it('a slow first token times out and fails over', async () => {
    await setup({ config: { ttftTimeoutMs: 150 } })
    h.fake.script('fa', 'big-400b', { kind: 'hang' })
    const r = await h.run()
    expect(r.start!.model).toBe('fb/alpha-120b')
    expect(r.done!.attempts[0]).toMatchObject({ failure: 'timeout', message: 'no first token within 150 ms' })
  })

  it('a role-only chunk followed by silence is not a first token', async () => {
    await setup({ config: { ttftTimeoutMs: 150 } })
    h.fake.script('fa', 'big-400b', { kind: 'roleThenHang' })
    const r = await h.run()
    expect(r.error).toBeUndefined()
    expect(r.start!.model).toBe('fb/alpha-120b')
  })

  it('an error inside a 200 stream before any token fails over', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'streamError', code: 429, message: 'Provider returned error' })
    const r = await h.run()
    expect(r.start!.model).toBe('fb/alpha-120b')
    expect(h.registry.get('fa/big-400b')!.state).toBe('cooling_down')
  })

  it('401 flags the key, skips that provider, and another provider answers', async () => {
    await setup({ keys: { fa: 1 } })
    h.fake.script('fa', 'big-400b', { kind: 'status', status: 401, body: { error: { message: 'Invalid API Key' } } })
    const r = await h.run()
    expect(r.start!.provider).not.toBe('fa')
    expect(h.vault.list('fa')[0]!.status).toBe('invalid')
    // Model state is untouched: the key was the problem.
    expect(h.registry.get('fa/big-400b')!.state).toBe('healthy')
    // Next request doesn't even consider fa.
    const next = await h.run()
    expect(next.done!.attempts.every((a) => a.provider !== 'fa')).toBe(true)
  })

  it('400 for context length skips the model for this request only', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'status', status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens" } } }, { kind: 'ok' })
    const r = await h.run()
    expect(r.done!.attempts[0]!.failure).toBe('context')
    // Request-specific: no state change and no reliability penalty.
    expect(h.registry.get('fa/big-400b')!.state).toBe('healthy')
    expect(h.health.reliability('fa/big-400b')).toBeCloseTo(0.9)
    expect((await h.run({ model: 'fa/big-400b' })).start!.model).toBe('fa/big-400b')
  })

  it('when every candidate is rate-limited the client gets a 429', async () => {
    await setup()
    for (const [p, m] of [['fa', 'big-400b'], ['fa', 'small-8b'], ['fb', 'alpha-120b'], ['fb', 'beta-30b'], ['fc', 'gamma-70b']] as const) {
      h.fake.script(p, m, { kind: 'status', status: 429 })
    }
    const r = await h.run()
    expect(r.error).toMatchObject({ status: 429, midStream: false, error: { code: 'rate_limited' } })
    expect(r.error!.attempts).toHaveLength(5)
    expect(h.requestLog.recent()[0]!.status).toBe('failed')
  })
})

describe('Router – mid-stream failure', () => {
  it('ends with an error chunk and does not retry silently', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'break', afterChunks: 2 })
    const r = await h.run()
    expect(r.text).toBe('part0 part1 ')
    expect(r.error).toMatchObject({ midStream: true, error: { code: 'stream_interrupted' } })
    expect(r.done).toBeUndefined()
    expect(h.fake.requests).toHaveLength(1)
    expect(h.requestLog.recent()[0]!.status).toBe('mid_stream_error')
    expect(h.registry.get('fa/big-400b')!.state).toBe('degraded')
  })

  it('client abort stops the stream without penalising the model', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'ok', text: 'a b c d e f g h', chunkDelayMs: 40 })
    const ac = new AbortController()
    const events = []
    for await (const e of h.router.route({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, { source: 'chat', signal: ac.signal })) {
      events.push(e)
      if (e.type === 'chunk' && events.length >= 3) ac.abort()
    }
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(h.registry.get('fa/big-400b')!.state).toBe('healthy')
    expect(h.requestLog.recent()[0]!.status).toBe('cancelled')
  })
})

describe('Router – strategies', () => {
  it('pinned uses the pinned model even if it is not the top scorer', async () => {
    await setup()
    const r = await h.run({ model: 'fb/beta-30b' })
    expect(r.start!.model).toBe('fb/beta-30b')
  })

  it('pinned falls back when allowed, and fails clearly when not', async () => {
    await setup()
    h.fake.script('fb', 'beta-30b', { kind: 'status', status: 503 })
    expect((await h.run({ model: 'fb/beta-30b' })).start!.model).toBe('fa/big-400b')

    await h.stop()
    await setup({ config: { allowFallbackWhenPinned: false } })
    h.fake.script('fb', 'beta-30b', { kind: 'status', status: 503 })
    const r = await h.run({ model: 'fb/beta-30b' })
    expect(r.error).toMatchObject({ status: 502 })
    expect(r.error!.attempts).toHaveLength(1)
  })

  it('chains keep the user order and skip missing models', async () => {
    await setup()
    h.chains.save('mine', ['fc/gamma-70b', 'fa/does-not-exist', 'fb/beta-30b'])
    expect((await h.run({ model: 'chain:mine' })).start!.model).toBe('fc/gamma-70b')
    h.fake.script('fc', 'gamma-70b', { kind: 'status', status: 500 })
    expect((await h.run({ model: 'chain:mine' })).start!.model).toBe('fb/beta-30b')
  })

  it('unknown models and chains are 404s with a helpful message', async () => {
    await setup()
    const a = await h.run({ model: 'gpt-4o' })
    expect(a.error).toMatchObject({ status: 404, error: { code: 'model_not_found' } })
    expect(a.error!.error.message).toContain('auto:coding')
    expect((await h.run({ model: 'chain:nope' })).error).toMatchObject({ status: 404, error: { code: 'chain_not_found' } })
    expect((await h.run({ model: 'fa/nope' })).error).toMatchObject({ status: 404 })
  })

  it('auto:fast prefers low latency over size', async () => {
    await setup()
    // Seed latency history: the 8b model is fast, the big one slow.
    for (let i = 0; i < 5; i++) {
      h.registry.recordOutcome('fa/small-8b', { latencyMs: 80 })
      h.registry.recordOutcome('fa/big-400b', { latencyMs: 6000 })
      h.registry.recordOutcome('fb/alpha-120b', { latencyMs: 6000 })
      h.registry.recordOutcome('fc/gamma-70b', { latencyMs: 6000 })
      h.registry.recordOutcome('fb/beta-30b', { latencyMs: 6000 })
    }
    expect((await h.run({ model: 'auto:fast' })).start!.model).toBe('fa/small-8b')
    expect((await h.run({ model: 'auto' })).start!.model).toBe('fa/big-400b')
  })
})

describe('Router – request needs', () => {
  it('tool requests go only to tool-capable models with tool quality ≥ 60, and stream tool calls', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'tools', name: 'read_file', args: '{"path":"src/index.ts"}' })
    const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]
    const r = await h.run({ tools })
    expect(r.start!.model).toBe('fa/big-400b')
    const calls = r.events.flatMap((e) => (e.type === 'chunk' ? e.chunk.choices.flatMap((c) => (c.delta.tool_calls as { function?: { arguments?: string } }[]) ?? []) : []))
    expect(calls.map((c) => c.function?.arguments ?? '').join('')).toBe('{"path":"src/index.ts"}')
    expect(r.done!.usage.completion_tokens).toBe(12)

    // Without tool support the small models are never candidates.
    for (const m of ['big-400b', 'alpha-120b', 'gamma-70b']) {
      const p = m === 'big-400b' ? 'fa' : m === 'alpha-120b' ? 'fb' : 'fc'
      h.fake.script(p, m, { kind: 'status', status: 503 })
    }
    const none = await h.run({ tools })
    expect(none.error!.attempts.map((a) => a.model).sort()).toEqual(['fa/big-400b', 'fb/alpha-120b', 'fc/gamma-70b'])
  })

  it('vision requests need a vision model', async () => {
    await setup()
    const r = await h.run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }]
    })
    expect(r.start!.model).toBe('fc/gamma-70b')
  })

  it('private mode excludes providers that may train on data', async () => {
    await setup({ providers: { fa: { mayTrain: true } } })
    expect((await h.run()).start!.provider).toBe('fa')
    expect((await h.run({}, { privateMode: true })).start!.provider).not.toBe('fa')
    // Even pinned: private mode is a hard rule.
    expect((await h.run({ model: 'fa/big-400b' }, { privateMode: true })).start!.provider).not.toBe('fa')
  })

  it('long prompts skip models whose context is too small (60% rule)', async () => {
    await setup({ models: { fa: [{ id: 'small-8b', context_length: 8192 }], fb: [{ id: 'beta-30b', context_length: 32768 }], fc: [] } })
    const long = 'x'.repeat(4 * 6000) // ~6k tokens: > 60% of 8192, fits 32k
    const r = await h.run({ messages: [{ role: 'user', content: long }] })
    expect(r.start!.model).toBe('fb/beta-30b')
  })

  it('explains an empty registry', async () => {
    await setup({ keys: { fa: 0, fb: 0, fc: 0 } })
    const r = await h.run()
    expect(r.error).toMatchObject({ status: 503, error: { code: 'no_models_available' } })
    expect(r.error!.error.message).toContain('Add a provider key')
  })

  it('reports why nothing is routable', async () => {
    await setup()
    for (const k of h.vault.list()) h.vault.setEnabled(k.id, false)
    const r = await h.run()
    expect(r.error).toMatchObject({ status: 503, error: { code: 'no_models_available' } })
    expect(r.error!.error.message).toContain('no usable key')
  })
})

describe('Router – quota and keys', () => {
  it('local RPM counters exclude a model once its budget is spent', async () => {
    await setup({ providers: { fa: { limits: { rpm: 2 } } } })
    expect((await h.run()).start!.model).toBe('fa/big-400b')
    expect((await h.run()).start!.model).toBe('fa/big-400b')
    expect((await h.run()).start!.provider).not.toBe('fa')
  })

  it('account-wide limits share one counter across all models (OpenRouter)', async () => {
    await setup({ providers: { fa: { scope: 'account', rotation: false, limits: { rpd: 1 } } } })
    expect((await h.run()).start!.model).toBe('fa/big-400b')
    // small-8b is a different model but the same account budget.
    const r = await h.run({ model: 'fa/small-8b' })
    expect(r.start!.provider).not.toBe('fa')
  })

  it('provider headers reporting 0 remaining override local counters', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'ok', headers: { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '1m' } })
    expect((await h.run()).start!.model).toBe('fa/big-400b')
    expect((await h.run()).start!.provider).not.toBe('fa')
  })

  it('rotates keys round-robin where allowed', async () => {
    await setup({ keys: { fb: 2 } })
    h.registry.setEnabled('fa/big-400b', false)
    h.registry.setEnabled('fa/small-8b', false)
    await h.run()
    await h.run()
    const auths = h.fake.callsTo('fb').map((c) => c.headers.authorization)
    expect(new Set(auths).size).toBe(2)
  })

  it('does not rotate where the provider forbids it', async () => {
    await setup({ keys: { fb: 2 }, providers: { fb: { rotation: false } } })
    h.registry.setEnabled('fa/big-400b', false)
    h.registry.setEnabled('fa/small-8b', false)
    await h.run()
    await h.run()
    expect(new Set(h.fake.callsTo('fb').map((c) => c.headers.authorization)).size).toBe(1)
  })
})
