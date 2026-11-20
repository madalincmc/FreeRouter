import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { ChatMessageView, ConversationSummary, ConversationView, MessageMeta, MessageStatus } from '@shared/ipc'

interface ConversationRow {
  id: string
  title: string
  pinned_model: string | null
  private_mode: number
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  meta_json: string
  created_at: number
}

const toSummary = (r: ConversationRow): ConversationSummary => ({
  id: r.id,
  title: r.title,
  model: r.pinned_model ?? 'auto',
  privateMode: r.private_mode === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toMessage = (r: MessageRow): ChatMessageView => {
  let meta: MessageMeta = {}
  try {
    meta = JSON.parse(r.meta_json) as MessageMeta
  } catch {
    /* keep empty */
  }
  return { id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content, status: r.status, meta, createdAt: r.created_at }
}

export const DEFAULT_TITLE = 'New chat'

/** Title from the first user message: first line, trimmed to ~60 chars. No model call is spent on it. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim()
  if (!line) return DEFAULT_TITLE
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line
}

/** Chat history in SQLite (PRD §10 conversations/messages). */
export class ConversationStore {
  private lastTs = 0

  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => number = Date.now
  ) {}

  /** Strictly increasing timestamps keep message order stable even within one millisecond. */
  private now(): number {
    this.lastTs = Math.max(this.clock(), this.lastTs + 1)
    return this.lastTs
  }

  list(): ConversationSummary[] {
    return this.db.prepare<[], ConversationRow>('SELECT * FROM conversations ORDER BY updated_at DESC').all().map(toSummary)
  }

  summary(id: string): ConversationSummary {
    const row = this.db.prepare<[string], ConversationRow>('SELECT * FROM conversations WHERE id = ?').get(id)
    if (!row) throw new Error('Conversation not found')
    return toSummary(row)
  }

  get(id: string): ConversationView {
    return { ...this.summary(id), messages: this.messages(id) }
  }

  messages(conversationId: string): ChatMessageView[] {
    return this.db
      .prepare<[string], MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid')
      .all(conversationId)
      .map(toMessage)
  }

  message(id: string): ChatMessageView | undefined {
    const row = this.db.prepare<[string], MessageRow>('SELECT * FROM messages WHERE id = ?').get(id)
    return row && toMessage(row)
  }

  create(model = 'auto', privateMode = false): ConversationSummary {
    const id = randomUUID()
    const now = this.now()
    this.db
      .prepare('INSERT INTO conversations (id, title, pinned_model, private_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, DEFAULT_TITLE, model === 'auto' ? null : model, privateMode ? 1 : 0, now, now)
    return this.summary(id)
  }

  rename(id: string, title: string): ConversationSummary {
    const t = title.trim().slice(0, 120) || DEFAULT_TITLE
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(t, id)
    return this.summary(id)
  }

  setOptions(id: string, o: { model?: string; privateMode?: boolean }): ConversationSummary {
    if (o.model !== undefined) {
      this.db.prepare('UPDATE conversations SET pinned_model = ? WHERE id = ?').run(o.model === 'auto' ? null : o.model, id)
    }
    if (o.privateMode !== undefined) {
      this.db.prepare('UPDATE conversations SET private_mode = ? WHERE id = ?').run(o.privateMode ? 1 : 0, id)
    }
    return this.summary(id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes > 0
  }

  touch(id: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  addMessage(
    conversationId: string,
    m: { role: 'user' | 'assistant'; content: string; status?: MessageStatus; meta?: MessageMeta }
  ): ChatMessageView {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO messages (id, conversation_id, role, content, model_used, created_at, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, conversationId, m.role, m.content, m.meta?.model ?? null, this.now(), m.status ?? 'complete', JSON.stringify(m.meta ?? {}))
    this.touch(conversationId)
    return this.message(id)!
  }

  updateMessage(id: string, m: { content: string; status: MessageStatus; meta: MessageMeta }): ChatMessageView {
    this.db
      .prepare('UPDATE messages SET content = ?, status = ?, meta_json = ?, model_used = ? WHERE id = ?')
      .run(m.content, m.status, JSON.stringify(m.meta), m.meta.model ?? null, id)
    return this.message(id)!
  }

  deleteMessage(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  /** Replies left "streaming" by a crash or quit are marked stopped at startup. */
  recoverInterrupted(): number {
    return this.db.prepare("UPDATE messages SET status = 'stopped' WHERE status = 'streaming'").run().changes
  }
}
