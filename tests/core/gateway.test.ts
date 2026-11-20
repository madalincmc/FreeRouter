import OpenAI from 'openai'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { gatewayModels } from '@core/gateway/models'
import { boundPort, generateToken, startGateway } from '@core/gateway/server'
import { makeHarness, type Harness, type HarnessOptions } from '../routerHarness'

let h: Harness
let gw: FastifyInstance
let base: string
let token: string
let client: OpenAI

async function setup(o: HarnessOptions = {}, extra: { origins?: string[] } = {}) {
  h = await makeHarness(o)
  token = generateToken()
  gw = await startGateway(
    {
      route: (req, opts) => h.router.route(req, opts),
      listModels: () => gatewayModels(h.registry.list(), h.providers.list((id) => h.vault.list(id)), h.chains.list().map((c) => c.name)),
      healthyCount: () => 5,
      token: () => token,
      allowedOrigins: () => extra.origins ?? [],
      version: 'test'
    },
    0
  )
  base = `http://127.0.0.1:${boundPort(gw)}`
  client = new OpenAI({ baseURL: `${base}/v1`, apiKey: token, maxRetries: 0 })
}
afterEach(async () => {
  await gw?.close()
  await h?.stop()
})

describe('Gateway with the official openai SDK', () => {
  it('streams a completion with the real model and x-fr headers', async () => {
    await setup()
    const { data: stream, response } = await client.chat.completions
      .create({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } })
      .withResponse()
    expect(response.headers.get('x-fr-provider')).toBe('fa')
    expect(response.headers.get('x-fr-model')).toBe('fa/big-400b')
    expect(response.headers.get('x-fr-attempts')).toBe('1')
    let text = ''
    let usage: OpenAI.CompletionUsage | null | undefined
    const ids = new Set<string>()
    for await (const chunk of stream) {
      ids.add(chunk.id)
      expect(chunk.model).toBe('fa/big-400b')
      text += chunk.choices[0]?.delta.content ?? ''
      if (chunk.usage) usage = chunk.usage
    }
    expect(text).toBe('Hello from big-400b')
    expect(ids.size).toBe(1)
    expect(usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 })
  })

  it('answers non-streaming requests with an aggregated completion', async () => {
    await setup()
    const c = await client.chat.completions.create({ model: 'auto:fast', messages: [{ role: 'user', content: 'hi' }] })
    expect(c.object).toBe('chat.completion')
    expect(c.choices[0]!.message.content).toMatch(/^Hello from /)
    expect(c.choices[0]!.finish_reason).toBe('stop')
    expect(c.usage!.total_tokens).toBeGreaterThan(0)
  })

  it('round-trips tool calls in both modes', async () => {
    await setup()
    const tools: OpenAI.ChatCompletionTool[] = [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }
    ]
    h.fake.script('fa', 'big-400b', { kind: 'tools', name: 'read_file', args: '{"path":"src/index.ts"}' })
    const c = await client.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'read it' }], tools })
    const call = c.choices[0]!.message.tool_calls![0]!
    expect(c.choices[0]!.finish_reason).toBe('tool_calls')
    expect(call).toMatchObject({ id: 'call_fake_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } })
    expect(c.choices[0]!.message.content).toBeNull()

    // Streaming: the SDK's own accumulator rebuilds the same call from the deltas.
    const runner = client.chat.completions.stream({ model: 'auto', messages: [{ role: 'user', content: 'read it' }], tools })
    const final = await runner.finalChatCompletion()
    expect(final.choices[0]!.message.tool_calls![0]).toMatchObject({ function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } })
  })

  it('fails over invisibly (429 on the top model)', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'status', status: 429, headers: { 'retry-after': '30' } })
    const { data, response } = await client.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }).withResponse()
    expect(data.choices[0]!.message.content).toBe('Hello from alpha-120b')
    expect(response.headers.get('x-fr-attempts')).toBe('2')
    expect(data.model).toBe('fb/alpha-120b')
  })

  it('returns OpenAI-shaped errors the SDK understands', async () => {
    await setup()
    await expect(client.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      status: 404,
      code: 'model_not_found'
    })
    for (const [p, m] of [['fa', 'big-400b'], ['fa', 'small-8b'], ['fb', 'alpha-120b'], ['fb', 'beta-30b'], ['fc', 'gamma-70b']] as const) {
      h.fake.script(p, m, { kind: 'status', status: 429 })
    }
    // Streaming requests that fail before the first token get a real HTTP error, not a 200 stream.
    await expect(client.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true })).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited'
    })
    await expect(client.chat.completions.create({ model: 'auto', messages: [] })).rejects.toMatchObject({ status: 400 })
  })

  it('ends a broken stream with an error event and no retry', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'break', afterChunks: 2 })
    const stream = await client.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true })
    let text = ''
    await expect(
      (async () => {
        for await (const c of stream) text += c.choices[0]?.delta.content ?? ''
      })()
    ).rejects.toThrow(/interrupted/)
    expect(text).toBe('part0 part1 ')
    expect(h.fake.requests).toHaveLength(1)
  })

  it('lists virtual models, chains and routable models', async () => {
    await setup()
    h.chains.save('work', ['fb/alpha-120b'])
    h.registry.setEnabled('fa/small-8b', false)
    const ids = (await client.models.list()).data.map((m) => m.id)
    expect(ids.slice(0, 6)).toEqual(['auto', 'auto:coding', 'auto:reasoning', 'auto:fast', 'auto:long', 'chain:work'])
    expect(ids).toContain('fa/big-400b')
    expect(ids).not.toContain('fa/small-8b')
  })

  it('strips parameters the provider rejects (profile data) and OpenAI-only ones', async () => {
    await setup()
    await client.chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
      store: true,
      metadata: { a: 'b' },
      temperature: 0.2,
      tool_choice: 'auto' // without tools – removed so providers don't 400
    })
    const body = h.fake.requests[0]!.body
    expect(body).toMatchObject({ model: 'big-400b', stream: true, temperature: 0.2 })
    expect(body).not.toHaveProperty('store')
    expect(body).not.toHaveProperty('metadata')
    expect(body).not.toHaveProperty('tool_choice')
  })

  it('cancels upstream when the client disconnects', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'ok', text: 'a b c d e f g h i j', chunkDelayMs: 50 })
    const stream = await client.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true })
    let n = 0
    // Breaking out of the iterator makes the SDK abort the HTTP request (a client hang-up).
    for await (const _ of stream) if (++n === 2) break
    await new Promise((r) => setTimeout(r, 300))
    expect(h.requestLog.recent()[0]!.status).toBe('cancelled')
    expect(h.registry.get('fa/big-400b')!.state).toBe('healthy')
  })
})

describe('Gateway security (PRD §7)', () => {
  const post = (path: string, headers: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] })
    })

  it('rejects missing or wrong tokens with 401, and never accepts a provider key', async () => {
    await setup()
    expect((await post('/v1/chat/completions', {})).status).toBe(401)
    expect((await post('/v1/chat/completions', { authorization: 'Bearer fr-local-wrong' })).status).toBe(401)
    expect((await post('/v1/chat/completions', { authorization: 'Bearer sk-fake-fa-0-0123456789' })).status).toBe(401)
    const r = await fetch(`${base}/v1/models`)
    expect(r.status).toBe(401)
    expect(await r.json()).toMatchObject({ error: { code: 'invalid_api_key' } })
    expect(h.fake.requests).toHaveLength(0)
  })

  it('rejects browser origins (403) unless allow-listed, even with a valid token', async () => {
    await setup({}, { origins: ['http://localhost:5173'] })
    expect((await post('/v1/chat/completions', { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).status).toBe(403)
    expect((await post('/v1/chat/completions', { authorization: `Bearer ${token}`, origin: 'http://localhost:5173' })).status).toBe(200)
  })

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    await setup()
    const { request } = await import('node:http')
    const status = await new Promise<number>((resolve) => {
      const req = request(
        { host: '127.0.0.1', port: boundPort(gw), path: '/health', headers: { host: 'attacker.example' } },
        (res) => resolve(res.statusCode ?? 0)
      )
      req.end()
    })
    expect(status).toBe(403)
  })

  it('serves /health without a token and only on loopback', async () => {
    await setup()
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ status: 'ok', healthyModels: 5 })
    expect(gw.server.address()).toMatchObject({ address: '127.0.0.1' })
  })

  it('accepts x-api-key as an alternative and regenerated tokens immediately', async () => {
    await setup()
    expect((await post('/v1/chat/completions', { 'x-api-key': token })).status).toBe(200)
    const old = token
    token = generateToken()
    expect((await post('/v1/chat/completions', { authorization: `Bearer ${old}` })).status).toBe(401)
    expect(token).toMatch(/^fr-local-[\w-]{32}$/)
  })
})
