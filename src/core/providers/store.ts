import type Database from 'better-sqlite3'
import type { KeyView, Limits, ProviderView } from '@shared/ipc'
import { LimitsSchema, type Catalog, type ProviderProfile } from './catalog'

interface ProviderRow {
  id: string
  enabled: number
  limit_overrides_json: string
}

function parseLimits(json: string): Limits {
  try {
    const parsed = LimitsSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/** Removes empty/zero entries so "blank" in the UI means "use the default". */
export function cleanLimits(limits: Limits): Limits {
  const out: Limits = {}
  for (const k of ['rpm', 'rpd', 'tpm', 'tpd'] as const) {
    const v = limits[k]
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] = v
  }
  return out
}

export function effectiveLimits(profile: ProviderProfile, overrides: Limits): Limits {
  return { ...profile.limits, ...cleanLimits(overrides) }
}

/**
 * Provider state: static profiles come from the catalog (providers.json), user state
 * (enabled, limit overrides) lives in the `providers` table.
 */
export class ProviderStore {
  private readonly profiles = new Map<string, ProviderProfile>()

  constructor(
    private readonly db: Database.Database,
    catalog: Catalog
  ) {
    for (const p of catalog.providers) this.profiles.set(p.id, p)
  }

  /**
   * Upserts catalog data, keeping the user's limit overrides. The enabled flag follows the
   * profile's `defaultEnabled` until the user switches the provider themselves; a provider
   * that has a key stays enabled.
   */
  seed(): void {
    const upsert = this.db.prepare(
      `INSERT INTO providers (id, name, base_url, enabled, profile_json, limit_overrides_json, may_train_on_data)
       VALUES (@id, @name, @baseUrl, @enabled, @profile, '{}', @mayTrain)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         base_url = excluded.base_url,
         profile_json = excluded.profile_json,
         may_train_on_data = excluded.may_train_on_data`
    )
    this.db.transaction(() => {
      for (const p of this.profiles.values()) {
        upsert.run({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          enabled: p.defaultEnabled === false ? 0 : 1,
          profile: JSON.stringify(p),
          mayTrain: p.mayTrainOnData ? 1 : 0
        })
        this.applyDefault(p.id)
      }
    })()
  }

  /** Re-applies the catalog default unless the user chose; called on seed and after a key is added. */
  applyDefault(id: string): void {
    const p = this.profiles.get(id)
    if (!p) return
    this.db
      .prepare(
        `UPDATE providers SET enabled = CASE
           WHEN @def = 1 OR EXISTS (SELECT 1 FROM api_keys WHERE provider_id = @id) THEN 1 ELSE 0 END
         WHERE id = @id AND enabled_by_user = 0`
      )
      .run({ id, def: p.defaultEnabled === false ? 0 : 1 })
  }

  profile(id: string): ProviderProfile | undefined {
    return this.profiles.get(id)
  }

  has(id: string): boolean {
    return this.profiles.has(id)
  }

  list(keysFor: (providerId: string) => KeyView[]): ProviderView[] {
    const rows = new Map(
      this.db
        .prepare<[], ProviderRow>('SELECT id, enabled, limit_overrides_json FROM providers')
        .all()
        .map((r) => [r.id, r])
    )
    return [...this.profiles.values()].map((p) => {
      const row = rows.get(p.id)
      return {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        keyUrl: p.keyUrl,
        docsUrl: p.docsUrl,
        keyPrefix: p.keyPrefix,
        enabled: row ? row.enabled === 1 : true,
        mayTrainOnData: p.mayTrainOnData,
        limitScope: p.limitScope,
        keyRotation: p.keyRotation,
        notes: p.notes,
        defaultLimits: p.limits,
        limitOverrides: row ? parseLimits(row.limit_overrides_json) : {},
        keys: keysFor(p.id)
      }
    })
  }

  isEnabled(id: string): boolean {
    const row = this.db.prepare<[string], { enabled: number }>('SELECT enabled FROM providers WHERE id = ?').get(id)
    return row ? row.enabled === 1 : false
  }

  setEnabled(id: string, enabled: boolean): void {
    this.assertKnown(id)
    this.db.prepare('UPDATE providers SET enabled = ?, enabled_by_user = 1 WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  setLimitOverrides(id: string, overrides: Limits): void {
    this.assertKnown(id)
    this.db
      .prepare('UPDATE providers SET limit_overrides_json = ? WHERE id = ?')
      .run(JSON.stringify(cleanLimits(overrides)), id)
  }

  private assertKnown(id: string): void {
    if (!this.profiles.has(id)) throw new Error(`Unknown provider: ${id}`)
  }
}
