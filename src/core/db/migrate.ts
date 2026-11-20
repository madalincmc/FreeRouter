/**
 * Plain-SQL migration runner. Pure TypeScript: works with any driver that exposes
 * a better-sqlite3-like surface (better-sqlite3 in the app, node:sqlite in tests).
 */

export interface SqlStatement {
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
}

export interface Migration {
  version: number
  name: string
  sql: string
}

const FILE_RE = /(\d+)_([\w-]+)\.sql$/

/** Turns `{ './migrations/0001_init.sql': '...' }` into a sorted migration list. */
export function parseMigrationFiles(files: Record<string, string>): Migration[] {
  const migrations = Object.entries(files).map(([path, sql]) => {
    const m = FILE_RE.exec(path)
    if (!m) throw new Error(`Bad migration filename: ${path}`)
    return { version: Number(m[1]), name: m[2]!, sql }
  })
  migrations.sort((a, b) => a.version - b.version)
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrations must be numbered 1..n without gaps (found ${m.version})`)
  })
  return migrations
}

/** Bundled migrations, inlined at build time by Vite (also works under Vitest). */
export const bundledMigrations: Migration[] = parseMigrationFiles(
  import.meta.glob<string>('./migrations/*.sql', { query: '?raw', import: 'default', eager: true })
)

export function currentVersion(db: SqlDatabase): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

/** Applies every pending migration, each in its own transaction. Returns the new schema version. */
export function migrate(db: SqlDatabase, migrations: Migration[] = bundledMigrations): number {
  let version = currentVersion(db)
  for (const m of migrations) {
    if (m.version <= version) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${m.version}_${m.name} failed: ${(err as Error).message}`)
    }
    version = m.version
  }
  return version
}
