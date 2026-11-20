import type Database from 'better-sqlite3'
import type { CapabilityTag, ModelState, ModelView, ProviderSyncStatus, Quality, QualityProfile } from '@shared/ipc'
import type { EnrichedModel } from './enrich'
import { QUALITY_PROFILES } from './enrich'

/** A model missing from this many consecutive successful syncs is marked `gone` (PRD §5). */
export const GONE_AFTER_MISSED_SYNCS = 2
/** How long the "new" badge shows. */
export const NEW_BADGE_MS = 7 * 24 * 60 * 60 * 1000
const LATENCY_SAMPLES = 20

interface ModelRow {
  id: string
  provider_id: string
  model_id: string
  display_name: string
  is_free: number
  is_new: number
  enabled: number
  tags_json: string
  quality_json: string
  quality_override_json: string
  context_window: number | null
  max_output: number | null
  state: ModelState
  cooldown_until: number | null
  last_error: string | null
  latency_samples_json: string
  last_tested_at: number | null
  meta_json: string
  first_seen: number
  last_seen: number
  missed_syncs: number
}

export interface SyncDiff {
  added: string[]
  gone: string[]
  returned: string[]
  total: number
}

function parseJson<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

export const registryId = (providerId: string, modelId: string): string => `${providerId}/${modelId}`

/** The model registry: the app's source of truth for "what can I call right now" (PRD §5). */
export class ModelRegistry {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Applies a successful sync for one provider:
   * - upserts every listed model (catalog data refreshed; user enable/quality overrides kept)
   * - models seen for the first time after the provider's first sync get `is_new`
   * - unlisted models count a missed sync; after GONE_AFTER_MISSED_SYNCS they become `gone`
   * - a `gone` model that reappears goes back to `healthy`
   */
  applySync(providerId: string, models: EnrichedModel[]): SyncDiff {
    const now = this.now()
    const diff: SyncDiff = { added: [], gone: [], returned: [], total: models.length }

    const run = this.db.transaction(() => {
      const syncRow = this.db
        .prepare<[string], { success_count: number }>('SELECT success_count FROM registry_sync WHERE provider_id = ?')
        .get(providerId)
      const isInitialSync = !syncRow || syncRow.success_count === 0

      const existing = new Map(
        this.db
          .prepare<[string], { id: string; state: ModelState; missed_syncs: number }>(
            'SELECT id, state, missed_syncs FROM models WHERE provider_id = ?'
          )
          .all(providerId)
          .map((r) => [r.id, r])
      )

      const insert = this.db.prepare(
        `INSERT INTO models (id, provider_id, model_id, display_name, is_free, is_new, tags_json, quality_json,
                             context_window, max_output, first_seen, last_seen, missed_syncs, enabled, state, meta_json)
         VALUES (@id, @providerId, @modelId, @displayName, @isFree, @isNew, @tags, @quality,
                 @contextWindow, @maxOutput, @now, @now, 0, 1, 'healthy', @meta)`
      )
      const update = this.db.prepare(
        `UPDATE models SET model_id = @modelId, display_name = @displayName, is_free = @isFree, tags_json = @tags,
                quality_json = @quality, context_window = @contextWindow, max_output = @maxOutput,
                last_seen = @now, missed_syncs = 0, meta_json = @meta,
                state = CASE WHEN state = 'gone' THEN 'healthy' ELSE state END
         WHERE id = @id`
      )

      const listed = new Set<string>()
      for (const m of models) {
        const id = registryId(providerId, m.modelId)
        listed.add(id)
        const params = {
          id,
          providerId,
          modelId: m.modelId,
          displayName: m.displayName,
          isFree: m.isFree ? 1 : 0,
          isNew: !isInitialSync && m.isFree ? 1 : 0,
          tags: JSON.stringify(m.tags),
          quality: JSON.stringify(m.quality),
          contextWindow: m.contextWindow,
          maxOutput: m.maxOutput,
          now,
          meta: JSON.stringify({ inputModalities: m.inputModalities, supportedParameters: m.supportedParameters })
        }
        const prev = existing.get(id)
        if (!prev) {
          insert.run(params)
          diff.added.push(id)
        } else {
          update.run(params)
          if (prev.state === 'gone') diff.returned.push(id)
        }
      }

      const miss = this.db.prepare(
        `UPDATE models SET missed_syncs = missed_syncs + 1,
                state = CASE WHEN missed_syncs + 1 >= ${GONE_AFTER_MISSED_SYNCS} THEN 'gone' ELSE state END
         WHERE id = ?`
      )
      for (const [id, prev] of existing) {
        if (listed.has(id) || prev.state === 'gone') continue
        miss.run(id)
        if (prev.missed_syncs + 1 >= GONE_AFTER_MISSED_SYNCS) diff.gone.push(id)
      }

      this.db
        .prepare(
          `INSERT INTO registry_sync (provider_id, last_attempt_at, last_success_at, last_error, success_count)
           VALUES (?, ?, ?, NULL, 1)
           ON CONFLICT(provider_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
             last_success_at = excluded.last_success_at, last_error = NULL, success_count = success_count + 1`
        )
        .run(providerId, now, now)
    })
    run()
    return diff
  }

  /** A failed sync never touches models; it is only recorded. */
  recordSyncFailure(providerId: string, error: string): void {
    this.db
      .prepare(
        `INSERT INTO registry_sync (provider_id, last_attempt_at, last_error) VALUES (?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error`
      )
      .run(providerId, this.now(), error)
  }

  syncStatus(providerIds: string[]): ProviderSyncStatus[] {
    const rows = new Map(
      this.db
        .prepare<[], { provider_id: string; last_attempt_at: number | null; last_success_at: number | null; last_error: string | null }>(
          'SELECT provider_id, last_attempt_at, last_success_at, last_error FROM registry_sync'
        )
        .all()
        .map((r) => [r.provider_id, r])
    )
    const counts = new Map(
      this.db
        .prepare<[], { provider_id: string; total: number; free: number }>(
          `SELECT provider_id, COUNT(*) AS total, SUM(is_free) AS free FROM models WHERE state != 'gone' GROUP BY provider_id`
        )
        .all()
        .map((r) => [r.provider_id, r])
    )
    return providerIds.map((providerId) => {
      const r = rows.get(providerId)
      const c = counts.get(providerId)
      return {
        providerId,
        lastAttemptAt: r?.last_attempt_at ?? null,
        lastSuccessAt: r?.last_success_at ?? null,
        lastError: r?.last_error ?? null,
        modelCount: c?.total ?? 0,
        freeCount: c?.free ?? 0
      }
    })
  }

  list(): ModelView[] {
    return this.db
      .prepare<[], ModelRow>('SELECT * FROM models ORDER BY provider_id, display_name')
      .all()
      .map((r) => this.toView(r))
  }

  get(id: string): ModelView | undefined {
    const row = this.db.prepare<[string], ModelRow>('SELECT * FROM models WHERE id = ?').get(id)
    return row && this.toView(row)
  }

  setEnabled(id: string, enabled: boolean): ModelView {
    this.db.prepare('UPDATE models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
    return this.mustGet(id)
  }

  /** Sets (number) or clears (null) user overrides per quality profile. */
  setQualityOverride(id: string, changes: Partial<Record<QualityProfile, number | null>>): ModelView {
    const row = this.db
      .prepare<[string], { quality_override_json: string }>('SELECT quality_override_json FROM models WHERE id = ?')
      .get(id)
    if (!row) throw new Error(`Unknown model ${id}`)
    const overrides = parseJson<Quality>(row.quality_override_json, {})
    for (const p of QUALITY_PROFILES) {
      const v = changes[p]
      if (v === null) delete overrides[p]
      else if (typeof v === 'number') overrides[p] = Math.max(0, Math.min(100, Math.round(v)))
    }
    this.db.prepare('UPDATE models SET quality_override_json = ? WHERE id = ?').run(JSON.stringify(overrides), id)
    return this.mustGet(id)
  }

  /** Records the outcome of a call (test now, and later the router) on the model's live state. */
  recordOutcome(
    id: string,
    o: { latencyMs?: number; state?: ModelState; cooldownUntil?: number | null; error?: string | null; tested?: boolean }
  ): ModelView {
    const row = this.db
      .prepare<[string], { latency_samples_json: string }>('SELECT latency_samples_json FROM models WHERE id = ?')
      .get(id)
    if (!row) throw new Error(`Unknown model ${id}`)
    let samples = parseJson<number[]>(row.latency_samples_json, [])
    if (typeof o.latencyMs === 'number') samples = [...samples, o.latencyMs].slice(-LATENCY_SAMPLES)
    this.db
      .prepare(
        `UPDATE models SET latency_samples_json = @samples,
                state = COALESCE(@state, state),
                cooldown_until = CASE WHEN @setCooldown THEN @cooldown ELSE cooldown_until END,
                last_error = CASE WHEN @setError THEN @error ELSE last_error END,
                last_tested_at = CASE WHEN @tested THEN @now ELSE last_tested_at END
         WHERE id = @id`
      )
      .run({
        id,
        samples: JSON.stringify(samples),
        state: o.state ?? null,
        setCooldown: o.cooldownUntil !== undefined ? 1 : 0,
        cooldown: o.cooldownUntil ?? null,
        setError: o.error !== undefined ? 1 : 0,
        error: o.error ?? null,
        tested: o.tested ? 1 : 0,
        now: this.now()
      })
    return this.mustGet(id)
  }

  private mustGet(id: string): ModelView {
    const v = this.get(id)
    if (!v) throw new Error(`Unknown model ${id}`)
    return v
  }

  private toView(r: ModelRow): ModelView {
    const base = parseJson<Quality>(r.quality_json, {})
    const overrides = parseJson<Quality>(r.quality_override_json, {})
    const meta = parseJson<{ supportedParameters?: string[]; inputModalities?: string[] }>(r.meta_json, {})
    const now = this.now()
    return {
      id: r.id,
      providerId: r.provider_id,
      modelId: r.model_id,
      displayName: r.display_name,
      isFree: r.is_free === 1,
      isNew: r.is_new === 1 && now - r.first_seen < NEW_BADGE_MS,
      enabled: r.enabled === 1,
      tags: parseJson<CapabilityTag[]>(r.tags_json, []),
      quality: { ...base, ...overrides },
      qualityOverridden: QUALITY_PROFILES.filter((p) => overrides[p] !== undefined),
      contextWindow: r.context_window,
      maxOutput: r.max_output,
      supportedParameters: meta.supportedParameters ?? [],
      inputModalities: meta.inputModalities ?? [],
      // An expired cooldown reads as healthy again; the router re-evaluates on the next call.
      state:
        (r.state === 'cooling_down' || r.state === 'quota_exhausted') && r.cooldown_until !== null && r.cooldown_until <= now
          ? 'healthy'
          : r.state,
      cooldownUntil: r.cooldown_until,
      lastError: r.last_error,
      p50LatencyMs: median(parseJson<number[]>(r.latency_samples_json, [])),
      lastTestedAt: r.last_tested_at,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen
    }
  }
}
