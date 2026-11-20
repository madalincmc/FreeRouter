import type { AttemptView, ChatEvent, ChatMessageView, MessageMeta, MessageStatus } from '@shared/ipc'
import type { ChatMessage, ChatRequest, RouteOptions, RouterEvent } from '../routing/types'
import { ConversationStore, DEFAULT_TITLE, titleFrom } from './store'

export const CONTINUE_PROMPT =
  'Your previous answer was cut off. Continue it exactly where it stopped, without repeating anything already written and without any preamble.'

export interface ChatServiceDeps {
  store: ConversationStore
  route: (req: ChatRequest, opts: RouteOptions) => AsyncGenerator<RouterEvent>
  emit: (e: ChatEvent) => void
  /** Deltas are coalesced into one event per window (ms) to keep IPC light. 0 = every chunk. */
  flushMs?: number
  /** Global private mode (Settings); a conversation can also turn it on for itself. */
  privateMode?: () => boolean
}

interface RunSpec {
  conversationId: string
  messageId: string
  model: string
  history: ChatMessage[]
  prefix?: string
  meta?: MessageMeta
  excludeModels?: string[]
}

/** Messages that should be sent back to the model as context. */
function toHistory(messages: ChatMessageView[]): ChatMessage[] {
  return messages
    .filter((m) => m.role === 'user' || m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }))
}

/**
 * Chat orchestration over the router (PRD §9 Chat): streaming replies, stop, regenerate-with,
 * and "continue with another model" after a mid-stream failure.
 */
export class ChatService {
  private readonly running = new Map<string, { controller: AbortController; done: Promise<ChatMessageView> }>()

  constructor(private readonly d: ChatServiceDeps) {}

  send(conversationId: string, text: string): { userMessage: ChatMessageView; assistantMessageId: string } {
    const conv = this.d.store.summary(conversationId)
    const content = text.trim()
    if (!content) throw new Error('Message is empty')
    if (this.isBusy(conversationId)) throw new Error('A reply is still streaming in this conversation')

    const userMessage = this.d.store.addMessage(conversationId, { role: 'user', content })
    if (conv.title === DEFAULT_TITLE) this.d.store.rename(conversationId, titleFrom(content))
    const history = toHistory(this.d.store.messages(conversationId))
    const assistant = this.d.store.addMessage(conversationId, {
      role: 'assistant',
      content: '',
      status: 'streaming',
      meta: { requested: conv.model }
    })
    this.start({ conversationId, messageId: assistant.id, model: conv.model, history })
    return { userMessage, assistantMessageId: assistant.id }
  }

  /** Drops the last reply and asks again, optionally with another model/profile (one-off). */
  regenerate(conversationId: string, model?: string): { assistantMessageId: string } {
    const conv = this.d.store.summary(conversationId)
    if (this.isBusy(conversationId)) throw new Error('A reply is still streaming in this conversation')
    const messages = this.d.store.messages(conversationId)
    const last = messages.at(-1)
    if (!last) throw new Error('Nothing to regenerate')
    if (last.role === 'assistant') this.d.store.deleteMessage(last.id)
    const history = toHistory(this.d.store.messages(conversationId))
    if (history.at(-1)?.role !== 'user') throw new Error('Nothing to regenerate')

    const requested = model ?? conv.model
    const assistant = this.d.store.addMessage(conversationId, { role: 'assistant', content: '', status: 'streaming', meta: { requested } })
    this.start({ conversationId, messageId: assistant.id, model: requested, history })
    return { assistantMessageId: assistant.id }
  }

  /** Resumes a cut-off reply on a different model, appending to the same message (PRD §6). */
  continue(conversationId: string, messageId: string): { assistantMessageId: string } {
    const conv = this.d.store.summary(conversationId)
    if (this.isBusy(conversationId)) throw new Error('A reply is still streaming in this conversation')
    const messages = this.d.store.messages(conversationId)
    const idx = messages.findIndex((m) => m.id === messageId)
    const target = messages[idx]
    if (!target || target.role !== 'assistant' || !target.content.trim()) throw new Error('Only a partial reply can be continued')
    if (target.status === 'complete') throw new Error('This reply is already complete')

    const history: ChatMessage[] = [
      ...toHistory(messages.slice(0, idx)),
      { role: 'assistant', content: target.content },
      { role: 'user', content: CONTINUE_PROMPT }
    ]
    const failed = target.meta.model
    const meta: MessageMeta = {
      ...target.meta,
      error: undefined,
      midStream: undefined,
      continuedFrom: [...(target.meta.continuedFrom ?? []), ...(failed ? [failed] : [])]
    }
    this.d.store.updateMessage(messageId, { content: target.content, status: 'streaming', meta })
    this.start({
      conversationId,
      messageId,
      model: conv.model.startsWith('auto') || conv.model.startsWith('chain:') ? conv.model : 'auto',
      history,
      prefix: target.content,
      meta,
      excludeModels: failed ? [failed] : []
    })
    return { assistantMessageId: messageId }
  }

  stop(messageId: string): boolean {
    const r = this.running.get(messageId)
    if (!r) return false
    r.controller.abort()
    return true
  }

  /** Resolves with the final message once the reply has finished (tests, shutdown). */
  whenDone(messageId: string): Promise<ChatMessageView> {
    return this.running.get(messageId)?.done ?? Promise.resolve(this.d.store.message(messageId)!)
  }

  isBusy(conversationId: string): boolean {
    for (const id of this.running.keys()) {
      if (this.d.store.message(id)?.conversationId === conversationId) return true
    }
    return false
  }

  stopAll(): void {
    for (const r of this.running.values()) r.controller.abort()
  }

  private start(spec: RunSpec): void {
    const controller = new AbortController()
    const done = this.run(spec, controller.signal).finally(() => this.running.delete(spec.messageId))
    this.running.set(spec.messageId, { controller, done })
  }

  private async run(spec: RunSpec, signal: AbortSignal): Promise<ChatMessageView> {
    const { conversationId, messageId } = spec
    const conv = this.d.store.summary(conversationId)
    let content = spec.prefix ?? ''
    let reasoning = spec.meta?.reasoning ?? ''
    const meta: MessageMeta = { ...(spec.meta ?? {}), requested: spec.meta?.requested ?? spec.model }
    let status: MessageStatus = 'streaming'

    // Coalesce deltas so a fast model doesn't flood IPC.
    let pending = { content: '', reasoning: '' }
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (!pending.content && !pending.reasoning) return
      this.d.emit({ type: 'delta', conversationId, messageId, ...pending })
      pending = { content: '', reasoning: '' }
    }
    const queue = (c: string, r: string): void => {
      pending.content += c
      pending.reasoning += r
      if ((this.d.flushMs ?? 30) === 0) flush()
      else timer ??= setTimeout(flush, this.d.flushMs ?? 30)
    }

    try {
      for await (const ev of this.d.route(
        { model: spec.model, messages: spec.history, stream: true },
        {
          source: 'chat',
          privateMode: conv.privateMode || this.d.privateMode?.() === true,
          signal,
          excludeModels: spec.excludeModels,
          stickyKey: `chat:${conversationId}`
        }
      )) {
        switch (ev.type) {
          case 'start':
            meta.provider = ev.provider
            meta.model = ev.model
            meta.attempts = ev.attempts as AttemptView[]
            this.d.emit({ type: 'start', conversationId, messageId, provider: ev.provider, model: ev.model, attempts: meta.attempts })
            break
          case 'chunk': {
            const delta = ev.chunk.choices[0]?.delta
            const c = typeof delta?.content === 'string' ? delta.content : ''
            const r = typeof delta?.reasoning === 'string' ? delta.reasoning : ''
            if (c || r) {
              content += c
              reasoning += r
              queue(c, r)
            }
            break
          }
          case 'done':
            meta.attempts = ev.attempts as AttemptView[]
            meta.ttftMs = ev.ttftMs
            meta.latencyMs = ev.latencyMs
            meta.usage = { prompt_tokens: ev.usage.prompt_tokens, completion_tokens: ev.usage.completion_tokens, estimated: ev.usage.estimated }
            status = 'complete'
            break
          case 'error':
            meta.attempts = ev.attempts as AttemptView[]
            meta.error = ev.error.message
            meta.midStream = ev.midStream || undefined
            status = 'error'
            break
        }
      }
    } catch (err) {
      meta.error = (err as Error).message
      status = 'error'
    }
    flush()
    if (signal.aborted && status !== 'complete') status = 'stopped'
    if (status === 'streaming') status = signal.aborted ? 'stopped' : 'error'
    if (reasoning) meta.reasoning = reasoning

    const message = this.d.store.updateMessage(messageId, { content, status, meta })
    this.d.store.touch(conversationId)
    this.d.emit({ type: 'end', conversationId, message })
    return message
  }
}
