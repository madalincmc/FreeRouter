import { afterEach, describe, expect, it } from 'vitest'
import type { ChatEvent } from '@shared/ipc'
import { modelOptions } from '@core/chat/options'
import { CONTINUE_PROMPT, ChatService } from '@core/chat/service'
import { titleFrom } from '@core/chat/store'
import { makeHarness, type Harness } from '../routerHarness'

let h: Harness
let events: ChatEvent[]
let chat: ChatService

async function setup() {
  h = await makeHarness()
  events = []
  chat = new ChatService({
    store: h.conversations,
    route: (req, opts) => h.router.route(req, opts),
    emit: (e) => events.push(e),
    flushMs: 0
  })
}
afterEach(async () => h?.stop())

describe('ChatService', () => {
  it('streams a reply with metadata, titles the conversation and keeps history', async () => {
    await setup()
    const conv = h.conversations.create()
    const { userMessage, assistantMessageId } = chat.send(conv.id, 'Say hello please')
    expect(userMessage).toMatchObject({ role: 'user', content: 'Say hello please', status: 'complete' })
    const reply = await chat.whenDone(assistantMessageId)

    expect(reply).toMatchObject({ role: 'assistant', status: 'complete', content: 'Hello from big-400b' })
    expect(reply.meta).toMatchObject({ provider: 'fa', model: 'fa/big-400b', requested: 'auto' })
    expect(reply.meta.attempts).toHaveLength(1)
    expect(reply.meta.ttftMs).toBeGreaterThanOrEqual(0)
    expect(events.map((e) => e.type)).toEqual(['start', 'delta', 'delta', 'delta', 'end'])
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { content: string }).content).join('')).toBe('Hello from big-400b')

    expect(h.conversations.summary(conv.id).title).toBe('Say hello please')
    // Second turn sends the whole history.
    await chat.whenDone(chat.send(conv.id, 'And again').assistantMessageId)
    const sent = h.fake.requests.at(-1)!.body['messages'] as { role: string; content: string }[]
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(h.requestLog.recent()[0]!.source).toBe('chat')
  })

  it('uses the conversation model and private mode', async () => {
    await setup()
    const conv = h.conversations.create()
    h.conversations.setOptions(conv.id, { model: 'fb/beta-30b' })
    const r1 = await chat.whenDone(chat.send(conv.id, 'hi').assistantMessageId)
    expect(r1.meta).toMatchObject({ model: 'fb/beta-30b', requested: 'fb/beta-30b' })
  })

  it('regenerate-with replaces the last reply using a one-off model', async () => {
    await setup()
    const conv = h.conversations.create()
    await chat.whenDone(chat.send(conv.id, 'hi').assistantMessageId)
    const { assistantMessageId } = chat.regenerate(conv.id, 'fc/gamma-70b')
    const r = await chat.whenDone(assistantMessageId)
    expect(r.meta).toMatchObject({ model: 'fc/gamma-70b', requested: 'fc/gamma-70b' })
    const msgs = h.conversations.messages(conv.id)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1]!.id).toBe(assistantMessageId)
    // The conversation's own model is unchanged.
    expect(h.conversations.summary(conv.id).model).toBe('auto')
  })

  it('a mid-stream failure keeps the partial answer, and continue finishes it on another model', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'break', afterChunks: 2 })
    const conv = h.conversations.create()
    const { assistantMessageId } = chat.send(conv.id, 'tell me a story')
    const broken = await chat.whenDone(assistantMessageId)
    expect(broken).toMatchObject({ status: 'error', content: 'part0 part1 ' })
    expect(broken.meta).toMatchObject({ midStream: true, model: 'fa/big-400b' })

    h.fake.script('fb', 'alpha-120b', { kind: 'ok', text: 'and the end.' })
    chat.continue(conv.id, assistantMessageId)
    const fixed = await chat.whenDone(assistantMessageId)
    expect(fixed).toMatchObject({ status: 'complete', content: 'part0 part1 and the end.' })
    expect(fixed.meta).toMatchObject({ model: 'fb/alpha-120b', continuedFrom: ['fa/big-400b'] })
    expect(fixed.meta.error).toBeUndefined()

    // The failed model is excluded and the partial answer is sent as context.
    const body = h.fake.requests.at(-1)!.body
    const msgs = body['messages'] as { role: string; content: string }[]
    expect(msgs.slice(-2)).toEqual([
      { role: 'assistant', content: 'part0 part1 ' },
      { role: 'user', content: CONTINUE_PROMPT }
    ])
    expect(h.fake.callsTo('fa', 'big-400b')).toHaveLength(1)
  })

  it('stop keeps what was streamed so far', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'ok', text: 'one two three four five six seven', chunkDelayMs: 30 })
    const conv = h.conversations.create()
    const { assistantMessageId } = chat.send(conv.id, 'count')
    await new Promise((r) => setTimeout(r, 90))
    expect(chat.stop(assistantMessageId)).toBe(true)
    const r = await chat.whenDone(assistantMessageId)
    expect(r.status).toBe('stopped')
    expect(r.content.length).toBeGreaterThan(0)
    expect(r.content).not.toBe('one two three four five six seven')
  })

  it('refuses a second send while a reply is streaming, and empty messages', async () => {
    await setup()
    h.fake.script('fa', 'big-400b', { kind: 'ok', chunkDelayMs: 20 })
    const conv = h.conversations.create()
    const { assistantMessageId } = chat.send(conv.id, 'hi')
    expect(() => chat.send(conv.id, 'again')).toThrow(/still streaming/)
    await chat.whenDone(assistantMessageId)
    expect(() => chat.send(conv.id, '   ')).toThrow(/empty/)
  })

  it('a routing error becomes an error message with attempts, not a crash', async () => {
    await setup()
    for (const [p, m] of [['fa', 'big-400b'], ['fa', 'small-8b'], ['fb', 'alpha-120b'], ['fb', 'beta-30b'], ['fc', 'gamma-70b']] as const) {
      h.fake.script(p, m, { kind: 'status', status: 503 })
    }
    const conv = h.conversations.create()
    const r = await chat.whenDone(chat.send(conv.id, 'hi').assistantMessageId)
    expect(r.status).toBe('error')
    expect(r.meta.error).toContain('candidate models failed')
    expect(r.meta.attempts).toHaveLength(5)
    expect(r.meta.midStream).toBeUndefined()
    // It can be regenerated.
    h.fake.script('fb', 'beta-30b', { kind: 'ok' })
    const again = await chat.whenDone(chat.regenerate(conv.id, 'fb/beta-30b').assistantMessageId)
    expect(again.status).toBe('complete')
  })

  it('recovers replies left streaming by a crash', async () => {
    await setup()
    const conv = h.conversations.create()
    h.conversations.addMessage(conv.id, { role: 'assistant', content: 'half', status: 'streaming' })
    expect(h.conversations.recoverInterrupted()).toBe(1)
    expect(h.conversations.messages(conv.id)[0]!.status).toBe('stopped')
  })
})

describe('chat helpers', () => {
  it('titles from the first line, trimmed', () => {
    expect(titleFrom('  Fix my regex\nIt fails on unicode')).toBe('Fix my regex')
    expect(titleFrom('x'.repeat(100))).toHaveLength(58)
    expect(titleFrom('   ')).toBe('New chat')
  })

  it('model options list only routable models, best first, plus virtual models and chains', async () => {
    await setup()
    h.registry.setEnabled('fa/small-8b', false)
    const opts = modelOptions(h.registry.list(), h.providers.list((id) => h.vault.list(id)), ['work'])
    expect(opts.virtual[0]!.value).toBe('auto')
    expect(opts.chains).toEqual(['work'])
    expect(opts.models.map((m) => m.id)).toEqual(['fa/big-400b', 'fb/alpha-120b', 'fc/gamma-70b', 'fb/beta-30b'])
    expect(opts.models[0]!.provider).toBe('Fake FA')
  })
})
