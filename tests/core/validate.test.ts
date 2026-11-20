import { describe, expect, it } from 'vitest'
import { bundledCatalog, type ProviderProfile } from '@core/providers/catalog'
import { testKey } from '@core/keys/validate'
import { fakeFetch } from '../helpers'

const profile = (id: string): ProviderProfile => bundledCatalog.providers.find((p) => p.id === id)!
const KEY = 'gsk_live0123456789abcdefXYZ'

describe('testKey', () => {
  it('sends the key as a Bearer token to the profile validation URL', async () => {
    const fetch = fakeFetch({ 'https://api.groq.com/openai/v1/models': { status: 200, body: { data: [] } } })
    const r = await testKey(profile('groq'), KEY, { fetch })
    expect(r).toMatchObject({ outcome: 'valid', httpStatus: 200 })
    expect(fetch.calls[0]!.headers['Authorization']).toBe(`Bearer ${KEY}`)
  })

  it('uses /api/v1/key for OpenRouter (its /models is public)', async () => {
    const fetch = fakeFetch({ 'https://openrouter.ai/api/v1/key': { status: 200, body: { data: {} } } })
    expect((await testKey(profile('openrouter'), 'sk-or-v1-abc12345678', { fetch })).outcome).toBe('valid')
  })

  it('sends profile-specific validation headers', async () => {
    const custom = { ...profile('groq'), validation: { ...profile('groq').validation, headers: { 'User-Agent': 'FreeRouter-Desktop' } } }
    const fetch = fakeFetch({ 'https://api.groq.com/openai/v1/models': { status: 401, body: { message: 'Bad credentials' } } })
    const r = await testKey(custom, KEY, { fetch })
    expect(r).toMatchObject({ outcome: 'invalid', httpStatus: 401, message: 'Bad credentials' })
    expect(fetch.calls[0]!.headers['User-Agent']).toBe('FreeRouter-Desktop')
  })

  it('validates NVIDIA keys with a 1-token chat POST (its /models is public)', async () => {
    const url = 'https://integrate.api.nvidia.com/v1/chat/completions'
    const fetch = fakeFetch({ [url]: (h) => (h['Authorization'] === 'Bearer nvapi-good0123456789' ? { status: 200 } : { status: 403, body: { status: 403, title: 'Forbidden', detail: 'Authorization failed' } }) })
    expect(await testKey(profile('nvidia'), 'nvapi-good0123456789', { fetch })).toMatchObject({ outcome: 'valid' })
    expect(await testKey(profile('nvidia'), 'nvapi-bad00123456789', { fetch })).toMatchObject({
      outcome: 'invalid',
      httpStatus: 403,
      message: 'Authorization failed'
    })
    const call = fetch.calls[0]!
    expect(call.method).toBe('POST')
    expect(call.headers['Content-Type']).toBe('application/json')
    expect(call.body).toMatchObject({ max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
  })

  it('a retired validation model (410) leaves the key untested rather than rejected', async () => {
    const url = 'https://integrate.api.nvidia.com/v1/chat/completions'
    const fetch = fakeFetch({ [url]: { status: 410, body: { status: 410, title: 'Gone', detail: 'end of life' } } })
    expect((await testKey(profile('nvidia'), 'nvapi-good0123456789', { fetch })).outcome).toBe('error')
  })

  it.each([401, 403])('treats %i as an invalid key', async (status) => {
    const fetch = fakeFetch({
      'https://api.groq.com/openai/v1/models': { status, body: { error: { message: 'Invalid API Key' } } }
    })
    expect(await testKey(profile('groq'), KEY, { fetch })).toMatchObject({ outcome: 'invalid', message: 'Invalid API Key' })
  })

  it("treats Gemini's 400 as an invalid key (profile data, not a code branch)", async () => {
    const fetch = fakeFetch({
      'https://generativelanguage.googleapis.com/v1beta/openai/models': {
        status: 400,
        body: [{ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }]
      }
    })
    const r = await testKey(profile('gemini'), 'AIzaSyBadKey000000000', { fetch })
    expect(r.outcome).toBe('invalid')
  })

  it('counts 429 and 402 as an accepted key', async () => {
    const url = 'https://openrouter.ai/api/v1/key'
    for (const status of [429, 402]) {
      const r = await testKey(profile('openrouter'), 'sk-or-v1-abc12345678', { fetch: fakeFetch({ [url]: { status } }) })
      expect(r.outcome).toBe('valid')
    }
  })

  it('reports 5xx as an error, not as an invalid key', async () => {
    const fetch = fakeFetch({ 'https://api.groq.com/openai/v1/models': { status: 503, body: 'upstream down' } })
    expect(await testKey(profile('groq'), KEY, { fetch })).toMatchObject({ outcome: 'error', httpStatus: 503 })
  })

  it('reports network errors without throwing', async () => {
    const fetch = fakeFetch({ 'https://api.groq.com/openai/v1/models': new Error('getaddrinfo ENOTFOUND') })
    const r = await testKey(profile('groq'), KEY, { fetch })
    expect(r.outcome).toBe('error')
    expect(r.message).toContain('ENOTFOUND')
  })

  it('times out slow providers', async () => {
    const fetch = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const r = await testKey(profile('groq'), KEY, { fetch, timeoutMs: 20 })
    expect(r).toMatchObject({ outcome: 'error', message: 'Timed out reaching the provider' })
  })

  it('never echoes the key back in a message', async () => {
    const fetch = fakeFetch({
      'https://api.groq.com/openai/v1/models': { status: 401, body: { error: { message: `Invalid key ${KEY}` } } }
    })
    const r = await testKey(profile('groq'), KEY, { fetch })
    expect(r.message).not.toContain('0123456789abcdef')
  })
})
