import { describe, expect, it } from 'vitest'
import { CompletionAggregator } from '@core/gateway/aggregate'
import { bundledCatalog } from '@core/providers/catalog'
import { buildUpstreamBody, ChunkNormalizer, mapFinishReason } from '@core/routing/normalize'
import type { ChatChunk } from '@core/routing/types'

const chunk = (delta: Record<string, unknown>, finish: string | null = null): ChatChunk => ({ choices: [{ index: 0, delta, finish_reason: finish }] })
const profile = (id: string) => bundledCatalog.providers.find((p) => p.id === id)!

describe('buildUpstreamBody', () => {
  it('swaps in the provider model id, forces streaming and strips profile + OpenAI-only params', () => {
    const body = buildUpstreamBody(
      { model: 'auto:coding', stream: false, messages: [], logprobs: true, logit_bias: {}, store: true, temperature: 0.1 },
      profile('groq'),
      'llama-3.3-70b-versatile'
    )
    expect(body).toEqual({ messages: [], temperature: 0.1, model: 'llama-3.3-70b-versatile', stream: true })
  })

  it('keeps params a provider supports', () => {
    const body = buildUpstreamBody({ model: 'auto', messages: [], logprobs: true }, profile('openrouter'), 'x')
    expect(body['logprobs']).toBe(true)
  })

  it('drops tool_choice and parallel_tool_calls when there are no tools', () => {
    const body = buildUpstreamBody({ model: 'auto', messages: [], tools: [], tool_choice: 'auto', parallel_tool_calls: false }, profile('openrouter'), 'x')
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
    expect(body).not.toHaveProperty('parallel_tool_calls')
  })
})

describe('ChunkNormalizer', () => {
  it('passes OpenAI-style fragments through unchanged', () => {
    const n = new ChunkNormalizer()
    const a = n.normalize(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '' } }] }))
    const b = n.normalize(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] }))
    expect(a.choices[0]!.delta.tool_calls).toEqual([{ index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '' } }])
    expect(b.choices[0]!.delta.tool_calls).toEqual([{ index: 0, function: { arguments: '{"x":' } }])
  })

  it('fixes whole tool calls without index/id and object arguments (Gemini-style)', () => {
    const n = new ChunkNormalizer()
    const out = n.normalize(
      chunk({
        tool_calls: [
          { function: { name: 'a', arguments: { q: 1 } } },
          { function: { name: 'b', arguments: '{}' } }
        ]
      })
    )
    const calls = out.choices[0]!.delta.tool_calls as { index: number; id: string; type: string; function: { name: string; arguments: string } }[]
    expect(calls.map((c) => c.index)).toEqual([0, 1])
    expect(calls.every((c) => c.id.startsWith('call_') && c.type === 'function')).toBe(true)
    expect(calls[0]!.function).toEqual({ name: 'a', arguments: '{"q":1}' })
  })

  it('maps finish reasons and reports tool_calls when tools were called', () => {
    expect(mapFinishReason('end_turn')).toBe('stop')
    expect(mapFinishReason('MAX_TOKENS')).toBe('length')
    expect(mapFinishReason('tool_use')).toBe('tool_calls')
    expect(mapFinishReason('weird')).toBe('stop')
    const n = new ChunkNormalizer()
    n.normalize(chunk({ tool_calls: [{ function: { name: 'a', arguments: '{}' } }] }))
    expect(n.normalize(chunk({}, 'stop')).choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('exposes reasoning_content as reasoning', () => {
    const out = new ChunkNormalizer().normalize(chunk({ reasoning_content: 'hmm' }))
    expect(out.choices[0]!.delta.reasoning).toBe('hmm')
  })
})

describe('CompletionAggregator', () => {
  it('merges content and multiple fragmented tool calls', () => {
    const agg = new CompletionAggregator()
    const n = new ChunkNormalizer()
    for (const c of [
      chunk({ role: 'assistant', content: 'Let me ' }),
      chunk({ content: 'check.' }),
      chunk({ tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'read', arguments: '{"p":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'c1', type: 'function', function: { name: 'list', arguments: '{}' } }] }),
      chunk({}, 'tool_calls')
    ]) {
      agg.add(n.normalize(c))
    }
    const r = agg.result({ id: 'x', created: 1, model: 'm', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) as {
      choices: { message: { content: string; tool_calls: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[]
    }
    const msg = r.choices[0]!.message
    expect(msg.content).toBe('Let me check.')
    expect(msg.tool_calls.map((t) => [t.id, t.function.name, t.function.arguments])).toEqual([
      ['c0', 'read', '{"p":"a"}'],
      ['c1', 'list', '{}']
    ])
    expect(r.choices[0]!.finish_reason).toBe('tool_calls')
  })
})
