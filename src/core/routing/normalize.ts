import { randomBytes } from 'node:crypto'
import type { ProviderProfile } from '../providers/catalog'
import type { ChatChunk, ChatRequest } from './types'

/**
 * OpenAI-platform-only parameters that third-party OpenAI-compatible providers reject or ignore.
 * Stripped for every provider; provider-specific lists live in the profile (`request.stripParams`).
 */
export const GLOBAL_STRIP_PARAMS = [
  'store',
  'metadata',
  'service_tier',
  'prediction',
  'modalities',
  'audio',
  'prompt_cache_key',
  'safety_identifier',
  'web_search_options'
] as const

/** Builds the body sent upstream: our routing fields replaced, rejected parameters removed (PRD §8). */
export function buildUpstreamBody(req: ChatRequest, profile: ProviderProfile, modelId: string): Record<string, unknown> {
  const strip = new Set<string>([...GLOBAL_STRIP_PARAMS, ...(profile.request?.stripParams ?? [])])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(req)) {
    if (k === 'model' || k === 'stream' || strip.has(k) || v === undefined) continue
    out[k] = v
  }
  // Without tools, tool_choice/parallel_tool_calls make some providers 400.
  if (!Array.isArray(out['tools']) || (out['tools'] as unknown[]).length === 0) {
    delete out['tools']
    delete out['tool_choice']
    delete out['parallel_tool_calls']
  }
  out['model'] = modelId
  out['stream'] = true
  return out
}

const FINISH_MAP: Record<string, string> = {
  stop: 'stop',
  end_turn: 'stop',
  stop_sequence: 'stop',
  eos: 'stop',
  eos_token: 'stop',
  length: 'length',
  max_tokens: 'length',
  model_length: 'length',
  tool_calls: 'tool_calls',
  tool_use: 'tool_calls',
  function_call: 'tool_calls',
  content_filter: 'content_filter',
  safety: 'content_filter',
  recitation: 'content_filter',
  error: 'stop'
}

export function mapFinishReason(reason: string | null | undefined): string | null {
  if (!reason) return null
  return FINISH_MAP[reason.toLowerCase()] ?? 'stop'
}

interface RawToolCall {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: unknown }
}

/**
 * Normalises one stream's chunks to OpenAI's incremental format (PRD §8): tool-call deltas always
 * carry an `index`; the first delta of each call carries `id`, `type` and the function name;
 * arguments are strings; finish reasons use OpenAI values ("tool_calls" when tools were called).
 * Providers that send whole tool calls in one delta are already valid and pass through.
 */
export class ChunkNormalizer {
  private readonly byId = new Map<string, number>()
  private readonly seen = new Set<number>()
  private next = 0
  private last = 0
  private sawToolCalls = false

  normalize(chunk: ChatChunk): ChatChunk {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? (choice.delta = {})
      if (Array.isArray(delta.tool_calls)) {
        delta.tool_calls = (delta.tool_calls as RawToolCall[]).map((tc) => this.toolCall(tc))
        if (delta.tool_calls.length) this.sawToolCalls = true
      }
      // Some providers send `reasoning_content`; expose it consistently as `reasoning` too.
      if (typeof delta['reasoning_content'] === 'string' && delta.reasoning === undefined) {
        delta.reasoning = delta['reasoning_content'] as string
      }
      if (choice.finish_reason !== undefined) {
        let fr = mapFinishReason(choice.finish_reason)
        if (fr === 'stop' && this.sawToolCalls) fr = 'tool_calls'
        choice.finish_reason = fr
      }
    }
    return chunk
  }

  private toolCall(tc: RawToolCall): RawToolCall {
    let index: number
    if (typeof tc.index === 'number') index = tc.index
    else if (tc.id && this.byId.has(tc.id)) index = this.byId.get(tc.id)!
    else if (tc.id || tc.function?.name) index = Math.max(this.next, ...[...this.seen].map((i) => i + 1))
    else index = this.last
    this.last = index
    this.next = Math.max(this.next, index + 1)

    const out: RawToolCall = { index }
    const first = !this.seen.has(index)
    if (first) {
      this.seen.add(index)
      out.id = tc.id ?? `call_${randomBytes(9).toString('base64url')}`
      out.type = 'function'
    } else if (tc.id) {
      out.id = tc.id
    }
    if (out.id) this.byId.set(out.id, index)

    const fn: { name?: string; arguments?: string } = {}
    if (tc.function?.name) fn.name = tc.function.name
    const args = tc.function?.arguments
    if (args !== undefined && args !== null) fn.arguments = typeof args === 'string' ? args : JSON.stringify(args)
    else if (first) fn.arguments = ''
    if (first || Object.keys(fn).length) out.function = fn
    return out
  }
}
