import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import Database from 'better-sqlite3'
import { migrate } from '@core/db/migrate'

export type Db = Database.Database

export function openDatabase(dataDir: string): { db: Db; schemaVersion: number } {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'freerouter.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  const schemaVersion = migrate(db)
  return { db, schemaVersion }
}

/** Typed JSON settings stored in the `settings` table. */
export class SettingsStore {
  private readonly getStmt
  private readonly setStmt

  constructor(db: Db) {
    this.getStmt = db.prepare<[string], { value_json: string }>('SELECT value_json FROM settings WHERE key = ?')
    this.setStmt = db.prepare<[string, string]>(
      'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json'
    )
  }

  get<T>(key: string, fallback: T): T {
    const row = this.getStmt.get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value_json) as T
    } catch {
      return fallback
    }
  }

  set<T>(key: string, value: T): T {
    this.setStmt.run(key, JSON.stringify(value))
    return value
  }
}
