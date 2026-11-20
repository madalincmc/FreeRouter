import { describe, expect, it } from 'vitest'
import {
  classifyHttpFailure,
  nextUtcMidnight,
  parseDuration,
  retryAtFromHeaders,
  stateForFailure
} from '@core/routing/errors'

const NOW = Date.UTC(2026, 10, 20, 15, 0, 0)
const headers = (h: Record<string, string> = {}) => {
  const m = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (n: string) => m.get(n.toLowerCase()) ?? null }
}

describe('retry timing', () => {
  it('parses Groq-style durations', () => {
    expect(parseDuration('2m59.56s')).toBe(179_560)
    expect(parseDuration('7.66s')).toBe(7_660)
    expect(parseDuration('1h2m')).toBe(3_720_000)
    expect(parseDuration('250ms')).toBe(250)
    expect(parseDuration('soon')).toBeNull()
  })

  it('reads retry-after (seconds and HTTP date), x-ratelimit-reset-* and epoch resets', () => {
    expect(retryAtFromHeaders(headers({ 'retry-after': '30' }), NOW)).toBe(NOW + 30_000)
    expect(retryAtFromHeaders(headers({ 'Retry-After': new Date(NOW + 5000).toUTCString() }), NOW)).toBe(NOW + 5000)
    expect(retryAtFromHeaders(headers({ 'x-ratelimit-reset-requests': '1m' }), NOW)).toBe(NOW + 60_000)
    expect(retryAtFromHeaders(headers({ 'X-RateLimit-Reset': String(NOW + 9000) }), NOW)).toBe(NOW + 9000)
    expect(retryAtFromHeaders(headers(), NOW)).toBeUndefined()
  })
})

describe('classifyHttpFailure', () => {
  it('429 → rate_limited with a 60 s default cooldown', () => {
    expect(classifyHttpFailure(429, headers(), 'Too many requests', NOW)).toMatchObject({
      kind: 'rate_limited',
      retryAt: NOW + 60_000
    })
  })

  it('429 mentioning a daily cap → quota_exhausted until the reset (or next UTC midnight)', () => {
    const body = '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}'
    expect(classifyHttpFailure(429, headers(), body, NOW)).toMatchObject({
      kind: 'quota_exhausted',
      retryAt: nextUtcMidnight(NOW)
    })
    const gemini = 'Quota exceeded for metric: generate_content_free_tier_requests, limit: GenerateRequestsPerDayPerProjectPerModel'
    expect(classifyHttpFailure(429, headers({ 'retry-after': '3600' }), gemini, NOW)).toMatchObject({
      kind: 'quota_exhausted',
      retryAt: NOW + 3_600_000
    })
  })

  it('maps the other statuses', () => {
    expect(classifyHttpFailure(402, headers(), '', NOW).kind).toBe('payment')
    expect(classifyHttpFailure(401, headers(), '', NOW).kind).toBe('auth')
    expect(classifyHttpFailure(403, headers(), '', NOW).kind).toBe('auth')
    expect(classifyHttpFailure(404, headers(), '', NOW).kind).toBe('not_found')
    expect(classifyHttpFailure(400, headers(), "This model's maximum context length is 8192 tokens", NOW).kind).toBe('context')
    expect(classifyHttpFailure(400, headers(), 'parallel_tool_calls is not supported', NOW).kind).toBe('bad_request')
    expect(classifyHttpFailure(503, headers(), '', NOW).kind).toBe('server')
  })
})

describe('stateForFailure', () => {
  it('cools down rate limits, exhausts quotas, degrades server errors, leaves request errors alone', () => {
    expect(stateForFailure({ kind: 'rate_limited', retryAt: 5, message: '' })).toEqual({ state: 'cooling_down', cooldownUntil: 5 })
    expect(stateForFailure({ kind: 'quota_exhausted', retryAt: 9, message: '' })).toEqual({ state: 'quota_exhausted', cooldownUntil: 9 })
    expect(stateForFailure({ kind: 'server', message: '' })).toEqual({ state: 'degraded' })
    expect(stateForFailure({ kind: 'auth', message: '' })).toEqual({})
    expect(stateForFailure({ kind: 'context', message: '' })).toEqual({})
  })
})
