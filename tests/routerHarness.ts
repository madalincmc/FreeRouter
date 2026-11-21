import { ConversationStore } from '@core/chat/store'
import { KeyVault } from '@core/keys/vault'
import type { FetchLike } from '@core/http'
import { parseCatalog } from '@core/providers/catalog'
import { ProviderStore } from '@core/providers/store'
import { ModelRegistry } from '@core/registry/store'
import { RegistryService } from '@core/registry/sync'
import { ChainStore } from '@core/routing/chains'
import { HealthTracker } from '@core/routing/health'
import { RequestLog } from '@core/routing/log'
import { QuotaTracker } from '@core/routing/quota'
import { Router } from '@core/routing/router'
import { StickyStore } from '@core/routing/sticky'
import { DEFAULT_ROUTER_CONFIG, type ChatRequest, type RouteOptions, type RouterConfig, type RouterEvent } from '@core/routing/types'
import { FakeProvider, type FakeModel } from './fakeProvider'
import { fakeEncryptor, memoryDb } from './helpers'

type Scope = 'account' | 'organization' | 'project' | 'key'

function profile(base: string, id: string, o: { scope?: Scope; rotation?: boolean; mayTrain?: boolean; limits?: object } = {}) {
  return {
    id,
    name: `Fake ${id.toUpperCase()}`,
    baseUrl: `${base}/${id}/v1`,
    keyUrl: 'https://example.com/keys',
    docsUrl: 'https://example.com/docs',
    termsUrl: 'https://example.com/terms',
    mayTrainOnData: o.mayTrain ?? false,
    limitScope: o.scope ?? 'organization',
    keyRotation: o.rotation ?? true,
    limits: o.limits ?? {},
    notes: '',
    validation: { url: `${base}/${id}/v1/models`, invalidStatuses: [401, 403] },
    models: {
      auth: 'required',
      listPath: 'data',
      fields: {
        id: 'id',
        contextWindow: 'context_length',
        supportedParameters: 'supported_parameters',
        inputModalities: 'input_modalities'
      },
      free: { all: true },
      exclude: []
    }
  }
}

/** Default fixture: three providers, scores by size (400b > 120b > 70b > 30b > 8b). */
export const FAKE_MODELS: Record<string, FakeModel[]> = {
  fa: [
    { id: 'big-400b', context_length: 131072, supported_parameters: ['tools', 'response_format'] },
    { id: 'small-8b', context_length: 8192, supported_parameters: [] }
  ],
  fb: [
    { id: 'alpha-120b', context_length: 131072, supported_parameters: ['tools'] },
    { id: 'beta-30b', context_length: 32768, supported_parameters: [] }
  ],
  fc: [{ id: 'gamma-70b', context_length: 65536, supported_parameters: ['tools'], input_modalities: ['text', 'image'] }]
}

export interface HarnessOptions {
  config?: Partial<RouterConfig>
  providers?: Partial<Record<'fa' | 'fb' | 'fc', { scope?: Scope; rotation?: boolean; mayTrain?: boolean; limits?: object }>>
  models?: Record<string, FakeModel[]>
  /** Keys per provider (default 1 each, fb gets 2). */
  keys?: Partial<Record<'fa' | 'fb' | 'fc', number>>
  /** Extra profile fields per provider, given the fake server's base URL (e.g. a `credential` spec). */
  patch?: Partial<Record<'fa' | 'fb' | 'fc', (base: string) => Record<string, unknown>>>
  /** Stored key text per provider and index (default `sk-fake-<p>-<i>-0123456789`). */
  keyText?: Partial<Record<'fa' | 'fb' | 'fc', (i: number) => string>>
}

export async function makeHarness(o: HarnessOptions = {}) {
  const fake = new FakeProvider()
  const base = await fake.start()
  const models = o.models ?? FAKE_MODELS
  for (const [p, list] of Object.entries(models)) fake.setModels(p, list)

  const catalog = parseCatalog({
    version: 1,
    limitsNote: '',
    providers: (['fa', 'fb', 'fc'] as const).map((id) => ({ ...profile(base, id, o.providers?.[id]), ...o.patch?.[id]?.(base) }))
  })
  const db = memoryDb()
  const providers = new ProviderStore(db, catalog)
  providers.seed()
  const vault = new KeyVault(db, fakeEncryptor())
  const keyCounts = { fa: 1, fb: 2, fc: 1, ...o.keys }
  for (const [p, n] of Object.entries(keyCounts)) {
    for (let i = 0; i < n; i++) {
      const key = o.keyText?.[p as 'fa' | 'fb' | 'fc']?.(i) ?? `sk-fake-${p}-${i}-0123456789`
      await vault.add({ providerId: p, label: `${p}-${i}`, key, status: 'valid' })
    }
  }

  const realFetch = ((url, init) => fetch(url, init)) as FetchLike
  const registry = new ModelRegistry(db)
  await new RegistryService({ registry, providers, vault, fetch: realFetch }).sync()

  const quota = new QuotaTracker(db)
  const health = new HealthTracker()
  const chains = new ChainStore(db)
  const requestLog = new RequestLog(db)
  const config: RouterConfig = { ...DEFAULT_ROUTER_CONFIG, ...o.config }
  const sticky = new StickyStore()

  const router = new Router({
    snapshot: () => ({ models: registry.list(), providers: providers.list((id) => vault.list(id)) }),
    profile: (id) => providers.profile(id),
    revealKey: (id) => vault.reveal(id),
    markKeyInvalid: (id) => vault.setStatus(id, 'invalid'),
    recordModelOutcome: (id, outcome) => void registry.recordOutcome(id, outcome),
    chains: (name) => chains.get(name),
    log: (e) => requestLog.write(e),
    quota,
    health,
    sticky,
    fetch: realFetch,
    config: () => config
  })

  async function run(req: Partial<ChatRequest> = {}, opts: Partial<RouteOptions> = {}) {
    const events: RouterEvent[] = []
    for await (const e of router.route(
      { model: 'auto', messages: [{ role: 'user', content: 'Say hello' }], ...req },
      { source: 'gateway', ...opts }
    )) {
      events.push(e)
    }
    const text = events
      .filter((e): e is Extract<RouterEvent, { type: 'chunk' }> => e.type === 'chunk')
      .map((e) => e.chunk.choices.map((c) => c.delta.content ?? '').join(''))
      .join('')
    const start = events.find((e) => e.type === 'start') as Extract<RouterEvent, { type: 'start' }> | undefined
    const done = events.find((e) => e.type === 'done') as Extract<RouterEvent, { type: 'done' }> | undefined
    const error = events.find((e) => e.type === 'error') as Extract<RouterEvent, { type: 'error' }> | undefined
    return { events, text, start, done, error }
  }

  const conversations = new ConversationStore(db)

  return { fake, router, registry, vault, providers, quota, health, chains, requestLog, conversations, sticky, config, run, stop: () => fake.stop() }
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>
