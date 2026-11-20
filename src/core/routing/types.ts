import type { QualityProfile } from '@shared/ipc'
import type { Failure } from './errors'

/** The OpenAI Chat Completions request, loosely typed: unknown fields pass through untouched. */
export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content?: string | null | Array<{ type: string; text?: string; image_url?: unknown; [k: string]: unknown }>
  name?: string
  tool_calls?: unknown[]
  tool_call_id?: string
  [k: string]: unknown
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
  response_format?: { type: string; [k: string]: unknown }
  max_tokens?: number
  max_completion_tokens?: number
  [k: string]: unknown
}

/** One streamed chunk in OpenAI `chat.completion.chunk` shape. */
export interface ChatChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices: Array<{
    index: number
    delta: { role?: string; content?: string | null; reasoning?: string | null; tool_calls?: unknown[]; [k: string]: unknown }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null
  [k: string]: unknown
}

/** Task profile used for scoring (PRD §6). `fast`/`long` reuse general quality with different needs. */
export type TaskProfile = 'general' | 'coding' | 'agentic' | 'reasoning' | 'fast' | 'long'

export type Strategy =
  | { kind: 'auto'; profile: TaskProfile | null } // null = infer from the request
  | { kind: 'pinned'; modelId: string } // registry id <provider>/<model_id>
  | { kind: 'chain'; name: string }

export interface Attempt {
  provider: string
  model: string // registry id
  outcome: 'ok' | 'failed' | 'skipped' | 'mid_stream_error'
  failure?: Failure['kind']
  status?: number
  message?: string
  ms: number
}

export interface RouteOptions {
  source: 'chat' | 'gateway'
  clientUa?: string
  privateMode?: boolean
  /** Raises the minimum context window (PRD §8 x-fr-min-context). */
  minContext?: number
  signal?: AbortSignal
}

export type RouterEvent =
  /** The first token arrived; everything after this is committed to one model. */
  | { type: 'start'; provider: string; model: string; modelId: string; attempts: Attempt[] }
  | { type: 'chunk'; chunk: ChatChunk }
  | {
      type: 'done'
      provider: string
      model: string
      attempts: Attempt[]
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; estimated: boolean }
      latencyMs: number
      ttftMs: number
    }
  /** Terminal error. `midStream` means some output was already sent (no retry happened). */
  | {
      type: 'error'
      midStream: boolean
      status: number
      error: { message: string; type: string; code: string }
      attempts: Attempt[]
    }

export interface RouterConfig {
  weights: { quality: number; reliability: number; speed: number; headroom: number }
  topN: number
  maxPerProvider: number
  ttftTimeoutMs: number
  totalTimeoutMs: number
  allowFallbackWhenPinned: boolean
  minToolsQuality: number
  /** A model is excluded when estimated prompt tokens exceed this share of its context (PRD §6: 60%). */
  contextFraction: number
  longContextTokens: number
  /** Context assumed for models that don't report one. */
  unknownContextWindow: number
  degradedStreak: number
  degradedCooldownMs: number
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  weights: { quality: 0.55, reliability: 0.2, speed: 0.15, headroom: 0.1 },
  topN: 5,
  maxPerProvider: 2,
  ttftTimeoutMs: 12_000,
  totalTimeoutMs: 120_000,
  allowFallbackWhenPinned: true,
  minToolsQuality: 60,
  contextFraction: 0.6,
  longContextTokens: 32_000,
  unknownContextWindow: 32_768,
  degradedStreak: 3,
  degradedCooldownMs: 5 * 60_000
}

export const QUALITY_FOR_PROFILE: Record<TaskProfile, QualityProfile[]> = {
  general: ['general'],
  fast: ['general'],
  long: ['general'],
  coding: ['coding'],
  reasoning: ['reasoning'],
  // Agentic coding needs both good code and reliable tool calls.
  agentic: ['coding', 'tools']
}
