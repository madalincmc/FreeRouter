import { describe, expect, it } from 'vitest'
import { maskKey, redact, redactError } from '@core/security/redact'

const SECRETS = [
  'sk-or-v1-0123456789abcdef0123456789abcdef',
  'gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'csk-abcdefghijklmnop12345678',
  'AIzaSyD-abcdefghijklmnopqrstuvwxyz0123',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
  'fr-local-6f1c2d9e8a7b4c3d'
]

describe('redact', () => {
  it.each(SECRETS)('hides bare key %s', (secret) => {
    const out = redact(`calling with ${secret} now`)
    expect(out).not.toContain(secret)
    expect(out).toContain('[REDACTED]')
  })

  it('hides Authorization headers in any shape', () => {
    for (const line of [
      'Authorization: Bearer abc.def.ghi',
      '{"authorization":"Bearer abc.def.ghi"}',
      "headers: { authorization: 'abc.def.ghi' }"
    ]) {
      expect(redact(line)).not.toContain('abc.def.ghi')
    }
  })

  it('hides key query parameters', () => {
    expect(redact('GET /v1beta/models?key=AIzaXYZ&alt=json')).toBe('GET /v1beta/models?key=[REDACTED]&alt=json')
  })

  it('leaves ordinary text alone', () => {
    const text = 'Model groq/llama-3.3-70b-versatile returned 429 after 120 ms'
    expect(redact(text)).toBe(text)
  })

  it('redacts error messages', () => {
    expect(redactError(new Error('401 for key sk-or-v1-0123456789abcdef'))).not.toContain('0123456789abcdef')
  })
})

describe('maskKey', () => {
  it('keeps a recognisable prefix and the last four characters', () => {
    expect(maskKey('sk-or-v1-0123456789abcdefa91f')).toBe('sk-or-…a91f')
    expect(maskKey('gsk_ABCDEFGHIJKLMNOP1234')).toBe('gsk_…1234')
  })

  it('never reveals most of a short key', () => {
    expect(maskKey('abcdef')).toBe('…ef')
  })
})
