import type { ChatMessage, ChatRequest, RouterConfig, Strategy, TaskProfile } from './types'

const FORCED_PROFILES: Record<string, TaskProfile> = {
  coding: 'coding',
  fast: 'fast',
  reasoning: 'reasoning',
  long: 'long',
  agentic: 'agentic',
  general: 'general'
}

export class UnknownModelError extends Error {
  constructor(public readonly requested: string) {
    super(
      `Unknown model "${requested}". Use "auto", "auto:coding", "auto:fast", "auto:reasoning", "auto:long", ` +
        `"chain:<name>" or a routable "<provider>/<model_id>" from GET /v1/models.`
    )
    this.name = 'UnknownModelError'
  }
}

/** Maps the request's `model` field to a routing strategy (PRD §6 table). */
export function parseModelField(model: string | undefined, knownProviders: Set<string>): Strategy {
  const m = (model ?? 'auto').trim()
  if (m === '' || m === 'auto') return { kind: 'auto', profile: null }
  if (m.startsWith('auto:')) {
    const profile = FORCED_PROFILES[m.slice(5)]
    if (!profile) throw new UnknownModelError(m)
    return { kind: 'auto', profile }
  }
  if (m.startsWith('chain:') && m.length > 6) return { kind: 'chain', name: m.slice(6) }
  const slash = m.indexOf('/')
  if (slash > 0 && knownProviders.has(m.slice(0, slash))) return { kind: 'pinned', modelId: m }
  throw new UnknownModelError(m)
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n')
  return ''
}

/**
 * Rough token estimate (~4 chars/token plus per-message overhead). Deliberately simple:
 * it only drives the context filter and TPM counting, both of which have safety margins.
 */
export function estimateTokens(req: Pick<ChatRequest, 'messages' | 'tools'>): number {
  let chars = 0
  for (const msg of req.messages) {
    chars += textOf(msg.content).length + 16
    if (msg.tool_calls) chars += JSON.stringify(msg.tool_calls).length
  }
  if (req.tools) chars += JSON.stringify(req.tools).length
  return Math.ceil(chars / 4)
}

export interface RequestNeeds {
  profile: TaskProfile
  tools: boolean
  vision: boolean
  json: boolean
  promptTokens: number
}

const CODE_RE = /```|^diff --git|^@@ .* @@|\b(function|def|class|const|import|return|public static|#include)\b|\.(ts|tsx|js|py|rs|go|java|cs|cpp)\b|\b(code|bug|refactor|compile|stack trace|regex|typescript|python|javascript)\b/im

/** Infers what the request needs (PRD §6 "Task-profile inference"). */
export function requestNeeds(req: ChatRequest, forced: TaskProfile | null, cfg: RouterConfig): RequestNeeds {
  const tools = Array.isArray(req.tools) && req.tools.length > 0 && req.tool_choice !== 'none'
  const vision = req.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url' || p.type === 'input_image')
  )
  const json = !!req.response_format && req.response_format.type !== 'text'
  const promptTokens = estimateTokens(req)

  let profile: TaskProfile
  if (forced) profile = forced
  else if (tools) profile = 'agentic'
  else if (promptTokens > cfg.longContextTokens) profile = 'long'
  else {
    const system = req.messages.filter((m) => m.role === 'system' || m.role === 'developer')
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    const probe = [...system, ...(last ? [last] : [])].map((m) => textOf(m.content)).join('\n')
    profile = CODE_RE.test(probe) ? 'coding' : 'general'
  }
  // Forcing auto:coding with tools still needs tool-capable models.
  if (tools && profile === 'coding') profile = 'agentic'
  return { profile, tools, vision, json, promptTokens }
}
