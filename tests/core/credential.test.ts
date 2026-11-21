import { describe, expect, it } from 'vitest'
import { testKey } from '@core/keys/validate'
import { bundledCatalog, type ProviderProfile } from '@core/providers/catalog'
import { fillUrl, KeyFormatError, needsKeyVars, resolveKey } from '@core/providers/credential'
import { classifyHttpFailure, unavailablePatterns } from '@core/routing/errors'
import { fakeFetch } from '../helpers'

const profile = (id: string): ProviderProfile => bundledCatalog.providers.find((p) => p.id === id)!
const noHeaders = { get: () => null }

describe('compound keys (Cloudflare ACCOUNT_ID:API_TOKEN)', () => {
  it('splits the key; the last part is the bearer and may contain the separator', () => {
    expect(resolveKey(profile('cloudflare'), ' acc123 : tok:en ')).toEqual({ bearer: 'tok:en', vars: { accountId: 'acc123' } })
    expect(resolveKey(profile('groq'), 'gsk_abc')).toEqual({ bearer: 'gsk_abc', vars: {} })
  })

  it('rejects a key without every part, without echoing the key', () => {
    for (const bad of ['justatoken', 'acc123:', ':token']) {
      expect(() => resolveKey(profile('cloudflare'), bad)).toThrow(KeyFormatError)
      try {
        resolveKey(profile('cloudflare'), bad)
      } catch (e) {
        expect((e as Error).message).toContain('ACCOUNT_ID:API_TOKEN')
        if (bad.length > 1) expect((e as Error).message).not.toContain(bad.replace(':', ''))
      }
    }
  })

  it('fills placeholders, URL-encoded, and reports unfilled ones', () => {
    const url = profile('cloudflare').models.url!
    expect(needsKeyVars(url)).toBe(true)
    const filled = fillUrl(url, { accountId: 'a/b' })
    expect(filled).toContain('/accounts/a%2Fb/ai/models/search')
    expect(needsKeyVars(filled)).toBe(false)
  })

  it('testKey calls the filled URL with only the token, and rejects a malformed key without a request', async () => {
    const url = 'https://api.cloudflare.com/client/v4/accounts/acc123/ai/models/search?per_page=1'
    const fetch = fakeFetch({ [url]: { status: 200, body: { success: true, result: [] } } })
    expect((await testKey(profile('cloudflare'), 'acc123:secret-token', { fetch })).outcome).toBe('valid')
    expect(fetch.calls[0]!.headers['Authorization']).toBe('Bearer secret-token')

    const r = await testKey(profile('cloudflare'), 'secret-token', { fetch })
    expect(r).toMatchObject({ outcome: 'invalid' })
    expect(fetch.calls).toHaveLength(1)
  })
})

describe('profile "unavailable" error patterns', () => {
  it('a Cloudflare paid-plan-only model cools down instead of flagging the key', () => {
    const body = JSON.stringify({ errors: [{ code: 5035, message: 'This model requires a Workers Paid plan' }], success: false })
    const f = classifyHttpFailure(403, noHeaders, body, 0, unavailablePatterns(profile('cloudflare')))
    expect(f.kind).toBe('no_free_quota')
    expect(f.retryAt).toBeGreaterThan(24 * 60 * 60_000)
    // Without the profile's patterns, a 403 is still an auth failure.
    expect(classifyHttpFailure(403, noHeaders, body, 0).kind).toBe('auth')
    expect(classifyHttpFailure(403, noHeaders, '{"errors":[{"code":10000,"message":"Authentication error"}]}', 0, unavailablePatterns(profile('cloudflare'))).kind).toBe('auth')
  })

  it('matches the wording Cloudflare actually returned (Nov 2026)', () => {
    const body = '{"errors":[{"message":"AiError: Model @cf/zai-org/glm-5.3 is not available on the Workers Free plan."}],"success":false}'
    expect(classifyHttpFailure(403, noHeaders, body, 0, unavailablePatterns(profile('cloudflare'))).kind).toBe('no_free_quota')
  })

  it('the daily neuron allocation running out waits until UTC midnight', () => {
    const body = '{"errors":[{"code":3036,"message":"You have used up your daily free allocation of 10,000 neurons."}]}'
    expect(classifyHttpFailure(429, noHeaders, body, 0, unavailablePatterns(profile('cloudflare'))).kind).toBe('quota_exhausted')
  })
})
