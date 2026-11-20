import { createHash } from 'node:crypto'
import type { ChatMessage } from './types'

/**
 * Conversation stickiness (PRD §6): remember the model that last succeeded for a session and try
 * it first next time, until it fails. Switching models mid-task hurts coding agents' coherence.
 * In memory only, with an idle TTL and a size cap.
 */
export class StickyStore {
  private readonly map = new Map<string, { modelId: string; at: number }>()

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly max = 1000
  ) {}

  get(key: string): string | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (this.now() - e.at > this.ttlMs) {
      this.map.delete(key)
      return undefined
    }
    return e.modelId
  }

  set(key: string, modelId: string): void {
    this.map.delete(key) // re-insert to keep LRU order
    this.map.set(key, { modelId, at: this.now() })
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!)
  }

  clear(key: string): void {
    this.map.delete(key)
  }
}

function text(m: ChatMessage | undefined): string {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) return m.content.map((p) => p.text ?? '').join('\n')
  return ''
}

/**
 * Session key for gateway clients (PRD §8): an explicit `x-fr-session` header wins; otherwise a
 * hash of the first system message (agents keep it constant for a task) plus the user-agent.
 */
export function gatewayStickyKey(messages: ChatMessage[], userAgent: string | undefined, sessionHeader?: string): string | undefined {
  if (sessionHeader) return `s:${sessionHeader.slice(0, 200)}`
  const anchor = text(messages.find((m) => m.role === 'system' || m.role === 'developer')) || text(messages.find((m) => m.role === 'user'))
  if (!anchor) return undefined
  return `g:${createHash('sha256').update(anchor).update('\0').update(userAgent ?? '').digest('hex').slice(0, 24)}`
}
