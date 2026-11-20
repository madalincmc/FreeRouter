import { describe, expect, it } from 'vitest'
import { KeyService } from '@core/keys/service'
import { KeyVault } from '@core/keys/vault'
import { bundledCatalog } from '@core/providers/catalog'
import { ProviderStore } from '@core/providers/store'
import { fakeEncryptor, fakeFetch, memoryDb, type FakeResponse } from '../helpers'

const GROQ_URL = 'https://api.groq.com/openai/v1/models'
const GOOD = 'gsk_good0123456789abcdef'
const BAD = 'gsk_bad00123456789abcdef'

function setup(groq: FakeResponse | Error | ((h: Record<string, string>, body: unknown) => FakeResponse)) {
  const db = memoryDb()
  const providers = new ProviderStore(db, bundledCatalog)
  providers.seed()
  const vault = new KeyVault(db, fakeEncryptor())
  const fetch = fakeFetch({ [GROQ_URL]: groq })
  return { vault, fetch, service: new KeyService(vault, providers, { fetch }) }
}

const byKey = (h: Record<string, string>): FakeResponse =>
  h['Authorization'] === `Bearer ${GOOD}` ? { status: 200 } : { status: 401, body: { error: { message: 'Invalid API Key' } } }

describe('KeyService.add', () => {
  it('saves a key the provider accepts as valid', async () => {
    const { service, vault } = setup(byKey)
    const r = await service.add({ providerId: 'groq', label: 'personal', key: `  ${GOOD}  ` })
    expect(r.saved).toBe(true)
    if (r.saved) expect(r.key).toMatchObject({ status: 'valid', masked: 'gsk_…cdef', label: 'personal' })
    expect(vault.list('groq')).toHaveLength(1)
  })

  it('does not save a key the provider rejects', async () => {
    const { service, vault } = setup(byKey)
    const r = await service.add({ providerId: 'groq', label: '', key: BAD })
    expect(r).toMatchObject({ saved: false, reason: 'invalid' })
    expect(r.saved === false && r.message).toContain('Invalid API Key')
    expect(vault.list()).toHaveLength(0)
  })

  it('saves as untested when the provider is unreachable', async () => {
    const { service } = setup(new Error('ECONNRESET'))
    const r = await service.add({ providerId: 'groq', label: '', key: GOOD })
    expect(r.saved && r.key.status).toBe('untested')
  })

  it('short-circuits duplicates without spending a test call', async () => {
    const { service, fetch } = setup(byKey)
    await service.add({ providerId: 'groq', label: '', key: GOOD })
    const r = await service.add({ providerId: 'groq', label: 'again', key: GOOD })
    expect(r).toMatchObject({ saved: false, reason: 'duplicate' })
    expect(fetch.calls).toHaveLength(1)
  })

  it('rejects unknown providers', async () => {
    const { service } = setup(byKey)
    await expect(service.add({ providerId: 'acme', label: '', key: GOOD })).rejects.toThrow(/Unknown provider/)
  })
})

describe('KeyService.test', () => {
  it('flags a key that has been revoked since it was added', async () => {
    let revoked = false
    const { service, vault } = setup((h) => (revoked ? { status: 401 } : byKey(h)))
    const r = await service.add({ providerId: 'groq', label: '', key: GOOD })
    if (!r.saved) throw new Error('expected saved')
    revoked = true
    expect((await service.test(r.key.id)).outcome).toBe('invalid')
    expect(vault.get(r.key.id)?.status).toBe('invalid')
  })

  it('keeps the previous status on network errors', async () => {
    let down = false
    const { service, vault } = setup((h) => {
      if (down) throw new Error('offline')
      return byKey(h)
    })
    const r = await service.add({ providerId: 'groq', label: '', key: GOOD })
    if (!r.saved) throw new Error('expected saved')
    down = true
    expect((await service.test(r.key.id)).outcome).toBe('error')
    expect(vault.get(r.key.id)?.status).toBe('valid')
  })
})
