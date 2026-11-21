import type { KeyView, ModelTestResult, SyncResult } from '@shared/ipc'
import { withTimeout, type FetchLike } from '../http'
import { errorMessage } from '../keys/validate'
import type { KeyVault } from '../keys/vault'
import type { ProviderProfile } from '../providers/catalog'
import { fillUrl, needsKeyVars, resolveKey, type ResolvedKey } from '../providers/credential'
import type { ProviderStore } from '../providers/store'
import { classifyHttpFailure, stateForFailure, unavailablePatterns, type Failure } from '../routing/errors'
import { redact } from '../security/redact'
import { parseModelList, modelsHeaders, modelsUrl } from './discover'
import { bundledSeed, enrich, type SeedFamily } from './enrich'
import type { ModelRegistry } from './store'

export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface RegistryServiceDeps {
  registry: ModelRegistry
  providers: ProviderStore
  vault: KeyVault
  fetch: FetchLike
  seed?: SeedFamily[]
  now?: () => number
  syncTimeoutMs?: number
  testTimeoutMs?: number
}

/** Picks the key to use for a provider: the first enabled key that isn't known to be invalid. */
export function usableKey(keys: KeyView[]): KeyView | undefined {
  return keys.find((k) => k.enabled && k.status === 'valid') ?? keys.find((k) => k.enabled && k.status === 'untested')
}

/** Sync orchestration and "test now" for the registry. Pure core; main supplies fetch and timers. */
export class RegistryService {
  private inFlight: Promise<SyncResult[]> | null = null
  private readonly now: () => number

  constructor(private readonly d: RegistryServiceDeps) {
    this.now = d.now ?? Date.now
  }

  /** Syncs every enabled provider (or one). Concurrent calls share the same run. */
  sync(providerId?: string): Promise<SyncResult[]> {
    if (providerId) return this.syncProvider(providerId).then((r) => [r])
    if (!this.inFlight) {
      const ids = this.d.providers.list(() => []).map((p) => p.id)
      this.inFlight = Promise.all(ids.map((id) => this.syncProvider(id))).finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  async syncProvider(providerId: string): Promise<SyncResult> {
    const profile = this.d.providers.profile(providerId)
    const result = (outcome: SyncResult['outcome'], message: string, extra: Partial<SyncResult> = {}): SyncResult => ({
      providerId,
      outcome,
      message,
      added: 0,
      gone: 0,
      total: 0,
      ...extra
    })
    if (!profile) return result('error', 'Unknown provider')
    if (!this.d.providers.isEnabled(providerId)) return result('skipped', 'Provider disabled')

    const spec = profile.models
    const keyView = spec.auth === 'none' ? undefined : usableKey(this.d.vault.list(providerId))
    if (spec.auth === 'required' && !keyView) return result('skipped', 'No usable key')

    let key: ResolvedKey | undefined
    try {
      key = keyView ? resolveKey(profile, await this.d.vault.reveal(keyView.id)) : undefined
    } catch (err) {
      return result('skipped', (err as Error).message)
    }
    const url = modelsUrl(spec, profile.baseUrl, key?.vars)
    if (!spec.inline && needsKeyVars(url)) return result('skipped', 'No usable key')

    // A fixed list in the profile (no list endpoint) goes through the same parsing as a fetched one.
    const res = spec.inline
      ? { value: { status: 200, ok: true, body: JSON.stringify(spec.inline) } }
      : await withTimeout(this.d.syncTimeoutMs ?? 20_000, async (signal) => {
          const r = await this.d.fetch(url, {
            method: 'GET',
            headers: modelsHeaders(spec, key?.bearer),
            signal
          })
          return { status: r.status, ok: r.ok, body: await r.text() }
        })

    if (!('value' in res)) {
      const msg = res.timedOut ? 'Timed out' : `Network error: ${redact(String((res.error as Error)?.message ?? res.error))}`
      this.d.registry.recordSyncFailure(providerId, msg)
      return result('error', msg)
    }
    const { status, ok, body } = res.value
    if (!ok) {
      if ((status === 401 || status === 403) && keyView) this.d.vault.setStatus(keyView.id, 'invalid')
      const msg = `HTTP ${status}: ${errorMessage(body) || 'no details'}`
      this.d.registry.recordSyncFailure(providerId, msg)
      return result('error', msg)
    }

    try {
      const discovered = parseModelList(spec, JSON.parse(body))
      if (discovered.length === 0) throw new Error('Provider returned no chat models')
      const enriched = discovered.map((m) => enrich(m, spec, this.d.seed ?? bundledSeed))
      const diff = this.d.registry.applySync(providerId, enriched)
      if (keyView && !spec.inline && keyView.status !== 'valid') this.d.vault.setStatus(keyView.id, 'valid')
      return result('ok', `${diff.total} models`, { added: diff.added.length, gone: diff.gone.length, total: diff.total })
    } catch (err) {
      // A malformed response never wipes the registry: nothing is applied.
      const msg = redact((err as Error).message)
      this.d.registry.recordSyncFailure(providerId, msg)
      return result('error', msg)
    }
  }

  /** "Test now": a tiny real completion against one model, updating its live state. */
  async testModel(id: string): Promise<ModelTestResult> {
    const model = this.d.registry.get(id)
    if (!model) throw new Error(`Unknown model ${id}`)
    const profile = this.d.providers.profile(model.providerId) as ProviderProfile
    const keyView = usableKey(this.d.vault.list(model.providerId))
    if (!keyView) {
      return { ok: false, latencyMs: 0, message: `Add a key for ${profile.name} to test this model`, model }
    }

    let key: ResolvedKey
    try {
      key = resolveKey(profile, await this.d.vault.reveal(keyView.id))
    } catch (err) {
      return { ok: false, latencyMs: 0, message: (err as Error).message, model }
    }
    const started = this.now()
    const res = await withTimeout(this.d.testTimeoutMs ?? 30_000, async (signal) => {
      const r = await this.d.fetch(`${fillUrl(profile.baseUrl, key.vars).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key.bearer}` },
        body: JSON.stringify({
          model: model.modelId,
          messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
          max_tokens: 16,
          temperature: 0,
          stream: false
        }),
        signal
      })
      return { status: r.status, ok: r.ok, headers: r.headers, body: await r.text() }
    })
    const latencyMs = this.now() - started

    let failure: Failure
    if (!('value' in res)) {
      failure = res.timedOut
        ? { kind: 'timeout', message: 'Timed out' }
        : { kind: 'network', message: `Network error: ${redact(String((res.error as Error)?.message ?? res.error))}` }
    } else if (res.value.ok) {
      const updated = this.d.registry.recordOutcome(id, {
        latencyMs,
        state: 'healthy',
        cooldownUntil: null,
        error: null,
        tested: true
      })
      return { ok: true, latencyMs, httpStatus: res.value.status, message: `Answered in ${latencyMs} ms`, model: updated }
    } else {
      failure = classifyHttpFailure(res.value.status, res.value.headers, res.value.body, this.now(), unavailablePatterns(profile))
      failure.message = errorMessage(res.value.body) || `HTTP ${res.value.status}`
      if (failure.kind === 'auth') this.d.vault.setStatus(keyView.id, 'invalid')
    }

    const message = redact(failure.message)
    const updated = this.d.registry.recordOutcome(id, { ...stateForFailure(failure), error: message, tested: true })
    return { ok: false, latencyMs, httpStatus: failure.status, message: `${failure.kind.replace('_', ' ')}: ${message}`, model: updated }
  }
}
