import { describe, expect, it } from 'vitest'
import { KeyVault } from '@core/keys/vault'
import { bundledCatalog } from '@core/providers/catalog'
import { ProviderStore } from '@core/providers/store'
import { countRoutable } from '@core/registry/routable'
import { ModelRegistry } from '@core/registry/store'
import { RegistryService } from '@core/registry/sync'
import { fakeEncryptor, fakeFetch, memoryDb, type FakeResponse } from '../helpers'
import { groqModels, openrouterModels } from '../fixtures/models'

const GROQ_MODELS = 'https://api.groq.com/openai/v1/models'
const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions'
const OR_MODELS = 'https://openrouter.ai/api/v1/models'
const GROQ_KEY = 'gsk_live0123456789abcdef'

type Route = FakeResponse | Error | ((h: Record<string, string>, body: unknown) => FakeResponse)

async function setup(routes: Record<string, Route>, opts: { groqKey?: boolean } = {}) {
  const db = memoryDb()
  const providers = new ProviderStore(db, bundledCatalog)
  providers.seed()
  const vault = new KeyVault(db, fakeEncryptor())
  if (opts.groqKey !== false) await vault.add({ providerId: 'groq', label: '', key: GROQ_KEY, status: 'valid' })
  let now = 1_000_000
  const registry = new ModelRegistry(db, () => now)
  const fetch = fakeFetch(routes)
  const service = new RegistryService({ registry, providers, vault, fetch, now: () => (now += 120) })
  return { registry, providers, vault, fetch, service }
}

describe('RegistryService.sync', () => {
  it('syncs public lists without a key and skips providers that need one', async () => {
    const { service, registry } = await setup({ [OR_MODELS]: { status: 200, body: openrouterModels } }, { groqKey: false })
    const results = await service.sync()
    const byId = Object.fromEntries(results.map((r) => [r.providerId, r]))
    expect(byId['openrouter']).toMatchObject({ outcome: 'ok', total: 5, added: 5 })
    expect(byId['groq']).toMatchObject({ outcome: 'skipped', message: 'No usable key' })
    expect(byId['cloudflare']).toMatchObject({ outcome: 'skipped', message: 'No usable key' })
    // Z.ai's list is fixed in its profile, so it syncs without a key or a request.
    expect(byId['zai']).toMatchObject({ outcome: 'ok', total: 3 })
    expect(registry.list().filter((m) => m.isFree)).toHaveLength(4 + 3)
  })

  it('fills compound-key placeholders and sends only the token part (Cloudflare)', async () => {
    const CF_MODELS = 'https://api.cloudflare.com/client/v4/accounts/acc123/ai/models/search?task=Text%20Generation&per_page=200'
    const { service, vault, fetch, registry } = await setup({
      [CF_MODELS]: {
        status: 200,
        body: { success: true, result: [{ name: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }, { name: '@cf/meta/llama-guard-3-8b' }] }
      }
    })
    await vault.add({ providerId: 'cloudflare', label: '', key: 'acc123:cf-token-0123456789', status: 'valid' })
    expect(await service.syncProvider('cloudflare')).toMatchObject({ outcome: 'ok', total: 1 })
    expect(fetch.calls[0]!.headers['Authorization']).toBe('Bearer cf-token-0123456789')
    expect(registry.list().map((m) => m.modelId)).toContain('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  })

  it('skips Cohere models marked deprecated', async () => {
    const COHERE_MODELS = 'https://api.cohere.com/v1/models?endpoint=chat&page_size=1000'
    const { service, vault } = await setup({
      [COHERE_MODELS]: {
        status: 200,
        body: {
          models: [
            { name: 'command-a-03-2025', context_length: 256000, is_deprecated: false },
            { name: 'command-r-03-2024', context_length: 128000, is_deprecated: true }
          ]
        }
      }
    })
    await vault.add({ providerId: 'cohere', label: '', key: 'cohere-trial-0123456789', status: 'valid' })
    expect(await service.syncProvider('cohere')).toMatchObject({ outcome: 'ok', total: 1 })
  })

  it('authenticates with the provider key', async () => {
    const { service, fetch } = await setup({ [GROQ_MODELS]: { status: 200, body: groqModels } })
    expect((await service.syncProvider('groq')).outcome).toBe('ok')
    expect(fetch.calls[0]!.headers['Authorization']).toBe(`Bearer ${GROQ_KEY}`)
  })

  it('skips disabled providers', async () => {
    const { service, providers } = await setup({})
    providers.setEnabled('groq', false)
    expect(await service.syncProvider('groq')).toMatchObject({ outcome: 'skipped', message: 'Provider disabled' })
  })

  it('a 401 marks the key invalid and keeps the existing registry', async () => {
    let fail = false
    const { service, registry, vault } = await setup({
      [GROQ_MODELS]: () => (fail ? { status: 401, body: { error: { message: 'Invalid API Key' } } } : { status: 200, body: groqModels })
    })
    await service.syncProvider('groq')
    fail = true
    const r = await service.syncProvider('groq')
    expect(r).toMatchObject({ outcome: 'error', message: 'HTTP 401: Invalid API Key' })
    expect(vault.list('groq')[0]!.status).toBe('invalid')
    expect(registry.list()).toHaveLength(2)
  })

  it('a malformed or empty response never wipes the registry', async () => {
    let body: unknown = groqModels
    const { service, registry } = await setup({ [GROQ_MODELS]: () => ({ status: 200, body }) })
    await service.syncProvider('groq')
    body = { data: [] }
    expect((await service.syncProvider('groq')).outcome).toBe('error')
    body = '<html>oops</html>'
    expect((await service.syncProvider('groq')).outcome).toBe('error')
    expect(registry.list().every((m) => m.state === 'healthy')).toBe(true)
  })

  it('network errors are reported per provider', async () => {
    const { service } = await setup({ [GROQ_MODELS]: new Error('getaddrinfo ENOTFOUND') })
    expect(await service.syncProvider('groq')).toMatchObject({ outcome: 'error' })
  })

  it('concurrent full syncs share one run', async () => {
    const { service, fetch } = await setup({
      [OR_MODELS]: { status: 200, body: openrouterModels },
      [GROQ_MODELS]: { status: 200, body: groqModels }
    })
    await Promise.all([service.sync(), service.sync()])
    expect(fetch.calls.filter((c) => c.url === GROQ_MODELS)).toHaveLength(1)
  })
})

describe('RegistryService.testModel', () => {
  async function synced(chat: Route) {
    const s = await setup({ [GROQ_MODELS]: { status: 200, body: groqModels }, [GROQ_CHAT]: chat })
    await s.service.syncProvider('groq')
    return s
  }

  it('sends a tiny completion and records latency on success', async () => {
    const { service, fetch } = await synced({ status: 200, body: { choices: [{ message: { content: 'OK' } }] } })
    const r = await service.testModel('groq/llama-3.3-70b-versatile')
    expect(r).toMatchObject({ ok: true, latencyMs: 120 })
    expect(r.model).toMatchObject({ state: 'healthy', p50LatencyMs: 120, lastError: null })
    expect(r.model.lastTestedAt).not.toBeNull()
    const call = fetch.calls.find((c) => c.url === GROQ_CHAT)!
    expect(call.body).toMatchObject({ model: 'llama-3.3-70b-versatile', max_tokens: 16, stream: false })
  })

  it('a 429 puts the model in cooldown until retry-after', async () => {
    const { service } = await synced({ status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'Rate limit reached' } } })
    const r = await service.testModel('groq/llama-3.3-70b-versatile')
    expect(r.ok).toBe(false)
    expect(r.model.state).toBe('cooling_down')
    expect(r.model.cooldownUntil).toBeGreaterThan(1_000_000)
    expect(r.model.lastError).toBe('Rate limit reached')
  })

  it('a 401 flags the key, not the model', async () => {
    const { service, vault } = await synced({ status: 401, body: { error: { message: 'Invalid API Key' } } })
    const r = await service.testModel('groq/llama-3.3-70b-versatile')
    expect(r.model.state).toBe('healthy')
    expect(vault.list('groq')[0]!.status).toBe('invalid')
  })

  it('a 5xx degrades the model', async () => {
    const { service } = await synced({ status: 503, body: 'upstream unavailable' })
    expect((await service.testModel('groq/llama-3.3-70b-versatile')).model.state).toBe('degraded')
  })

  it('without a key it explains instead of calling', async () => {
    const { service, fetch } = await setup({ [OR_MODELS]: { status: 200, body: openrouterModels } }, { groqKey: false })
    await service.syncProvider('openrouter')
    const r = await service.testModel('openrouter/openrouter/free')
    expect(r).toMatchObject({ ok: false, message: 'Add a key for OpenRouter to test this model' })
    expect(fetch.calls).toHaveLength(1)
  })
})

describe('countRoutable', () => {
  it('counts free, enabled, healthy models of enabled providers with a usable key', async () => {
    const { service, registry, providers, vault } = await setup({
      [OR_MODELS]: { status: 200, body: openrouterModels },
      [GROQ_MODELS]: { status: 200, body: groqModels }
    })
    await service.sync()
    const list = () => providers.list((id) => vault.list(id))
    expect(countRoutable(registry.list(), list())).toBe(2) // groq only: openrouter has no key
    registry.setEnabled('groq/llama-3.3-70b-versatile', false)
    expect(countRoutable(registry.list(), list())).toBe(1)
    providers.setEnabled('groq', false)
    expect(countRoutable(registry.list(), list())).toBe(0)
  })
})
