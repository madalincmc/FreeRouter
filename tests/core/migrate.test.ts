import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { bundledMigrations, currentVersion, migrate, parseMigrationFiles } from '@core/db/migrate'

const open = (): Database.Database => new Database(':memory:')

const tables = (db: Database.Database): string[] =>
  db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name)

describe('migrate', () => {
  it('creates the PRD §10 schema from scratch', () => {
    const db = open()
    expect(migrate(db)).toBe(bundledMigrations.length)
    expect(tables(db)).toEqual([
      'api_keys',
      'chains',
      'conversations',
      'messages',
      'models',
      'providers',
      'registry_sync',
      'request_log',
      'settings',
      'usage_counters'
    ])
  })

  it('is idempotent', () => {
    const db = open()
    migrate(db)
    expect(migrate(db)).toBe(currentVersion(db))
  })

  it('applies only pending migrations', () => {
    const db = open()
    migrate(db, parseMigrationFiles({ '0001_a.sql': 'CREATE TABLE a (x)' }))
    const v = migrate(
      db,
      parseMigrationFiles({ '0001_a.sql': 'CREATE TABLE a (x)', '0002_b.sql': 'CREATE TABLE b (y)' })
    )
    expect(v).toBe(2)
    expect(tables(db)).toEqual(['a', 'b'])
  })

  it('rolls back a failing migration and keeps the old version', () => {
    const db = open()
    const bad = parseMigrationFiles({ '0001_ok.sql': 'CREATE TABLE ok (x)', '0002_bad.sql': 'CREATE TABLE z (x); NOPE;' })
    expect(() => migrate(db, bad)).toThrow(/Migration 2_bad failed/)
    expect(currentVersion(db)).toBe(1)
    expect(tables(db)).toEqual(['ok'])
  })

  it('rejects gaps in migration numbering', () => {
    expect(() => parseMigrationFiles({ '0001_a.sql': '', '0003_c.sql': '' })).toThrow(/without gaps/)
  })

  it('enforces the key status enum and foreign keys', () => {
    const db = open()
    db.pragma('foreign_keys = ON')
    migrate(db)
    db.prepare("INSERT INTO providers (id, name, base_url) VALUES ('groq', 'Groq', 'https://x')").run()
    const insertKey = db.prepare(
      "INSERT INTO api_keys (id, provider_id, ciphertext, masked, status, created_at) VALUES (?, ?, x'00', '…', ?, 0)"
    )
    expect(() => insertKey.run('k1', 'groq', 'bogus')).toThrow(/CHECK/)
    expect(() => insertKey.run('k2', 'nope', 'untested')).toThrow(/FOREIGN KEY/)
    insertKey.run('k3', 'groq', 'untested')
    db.prepare("DELETE FROM providers WHERE id = 'groq'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 0 })
  })
})
