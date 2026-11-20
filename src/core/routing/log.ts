import type Database from 'better-sqlite3'
import type { Attempt } from './types'

/** One row of `request_log`: metadata only, never prompt or response bodies (PRD §10). */
export interface RequestLogEntry {
  ts: number
  source: 'chat' | 'gateway'
  clientUa: string | null
  requestedModel: string
  chosenModel: string | null
  attempts: Attempt[]
  status: string
  latencyMs: number | null
  ttftMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  error: string | null
}

export class RequestLog {
  constructor(private readonly db: Database.Database) {}

  write(e: RequestLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO request_log (ts, source, client_ua, requested_model, chosen_model, attempts_json, status,
                                  latency_ms, ttft_ms, prompt_tokens, completion_tokens, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.ts,
        e.source,
        e.clientUa,
        e.requestedModel,
        e.chosenModel,
        JSON.stringify(e.attempts),
        e.status,
        e.latencyMs,
        e.ttftMs,
        e.promptTokens,
        e.completionTokens,
        e.error
      )
  }

  recent(limit = 100): (RequestLogEntry & { id: number })[] {
    return this.db
      .prepare<[number], Record<string, unknown>>('SELECT * FROM request_log ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => ({
        id: r['id'] as number,
        ts: r['ts'] as number,
        source: r['source'] as 'chat' | 'gateway',
        clientUa: r['client_ua'] as string | null,
        requestedModel: r['requested_model'] as string,
        chosenModel: r['chosen_model'] as string | null,
        attempts: JSON.parse(r['attempts_json'] as string) as Attempt[],
        status: r['status'] as string,
        latencyMs: r['latency_ms'] as number | null,
        ttftMs: r['ttft_ms'] as number | null,
        promptTokens: r['prompt_tokens'] as number | null,
        completionTokens: r['completion_tokens'] as number | null,
        error: r['error'] as string | null
      }))
  }

  /** Retention (default 7 days handled by the caller's setting). */
  prune(olderThan: number): number {
    return this.db.prepare('DELETE FROM request_log WHERE ts < ?').run(olderThan).changes
  }
}
