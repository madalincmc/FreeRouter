import { describe, expect, it } from 'vitest'
import {
  classifyHttpFailure,
  nextUtcMidnight,
  UNAVAILABLE_COOLDOWN_MS,
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

  // Bodies captured live on 2026-11-20 (account ids removed).
  const GEMINI_ZERO_QUOTA = JSON.stringify([
    {
      error: {
        code: 429,
        message:
          'You exceeded your current quota, please check your plan and billing details. ' +
          '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-pro'
      }
    }
  ])

  it('a zero quota means "not on the free tier": out for a week, not until midnight', () => {
    expect(classifyHttpFailure(429, headers(), GEMINI_ZERO_QUOTA, NOW)).toMatchObject({
      kind: 'no_free_quota',
      retryAt: NOW + UNAVAILABLE_COOLDOWN_MS
    })
    // A normal daily cap with a real limit is still a daily quota.
    const daily = 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 250 per day'
    expect(classifyHttpFailure(429, headers(), daily, NOW).kind).toBe('quota_exhausted')
    expect(classifyHttpFailure(429, headers(), 'limit: 0.5 rps', NOW).kind).toBe('rate_limited')
  })

  it.each([
    ['Gemini retired for new users', '{"error":{"code":404,"message":"This model models/gemini-2.5-pro is no longer available to new users."}}'],
    ['NVIDIA not on this account', '{"status":404,"title":"Not Found","detail":"Function \'x\': Not found for account \'y\'"}']
  ])('404 (%s) takes the model out for a week', (_name, body) => {
    expect(classifyHttpFailure(404, headers(), body, NOW)).toMatchObject({ kind: 'not_found', retryAt: NOW + UNAVAILABLE_COOLDOWN_MS })
  })
})

describe('stateForFailure', () => {
  it('cools down rate limits, exhausts quotas, degrades server errors, leaves request errors alone', () => {
    expect(stateForFailure({ kind: 'rate_limited', retryAt: 5, message: '' })).toEqual({ state: 'cooling_down', cooldownUntil: 5 })
    expect(stateForFailure({ kind: 'quota_exhausted', retryAt: 9, message: '' })).toEqual({ state: 'quota_exhausted', cooldownUntil: 9 })
    expect(stateForFailure({ kind: 'not_found', retryAt: 7, message: '' })).toEqual({ state: 'cooling_down', cooldownUntil: 7 })
    expect(stateForFailure({ kind: 'no_free_quota', retryAt: 8, message: '' })).toEqual({ state: 'cooling_down', cooldownUntil: 8 })
    expect(stateForFailure({ kind: 'server', message: '' })).toEqual({ state: 'degraded' })
    expect(stateForFailure({ kind: 'auth', message: '' })).toEqual({})
    expect(stateForFailure({ kind: 'context', message: '' })).toEqual({})
  })
})
