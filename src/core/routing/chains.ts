import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface Chain {
  id: string
  name: string
  modelIds: string[]
}

/** User-defined ordered fallback chains (`chain:<name>`). The editor UI arrives in M6. */
export class ChainStore {
  constructor(private readonly db: Database.Database) {}

  list(): Chain[] {
    return this.db
      .prepare<[], { id: string; name: string; model_ids: string }>('SELECT id, name, model_ids FROM chains ORDER BY name')
      .all()
      .map((r) => ({ id: r.id, name: r.name, modelIds: JSON.parse(r.model_ids) as string[] }))
  }

  get(name: string): string[] | undefined {
    const row = this.db
      .prepare<[string], { model_ids: string }>('SELECT model_ids FROM chains WHERE name = ?')
      .get(name)
    return row ? (JSON.parse(row.model_ids) as string[]) : undefined
  }

  save(name: string, modelIds: string[]): Chain {
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error('Chain names use letters, digits, ".", "_" or "-" (max 40)')
    const existing = this.db.prepare<[string], { id: string }>('SELECT id FROM chains WHERE name = ?').get(name)
    const id = existing?.id ?? randomUUID()
    this.db
      .prepare(
        `INSERT INTO chains (id, name, model_ids) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, model_ids = excluded.model_ids`
      )
      .run(id, name, JSON.stringify(modelIds))
    return { id, name, modelIds }
  }

  delete(name: string): boolean {
    return this.db.prepare('DELETE FROM chains WHERE name = ?').run(name).changes > 0
  }
}
