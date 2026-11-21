import { afterEach, describe, expect, it } from 'vitest'
import { AppSettingsStore, DEFAULT_ROUTING, normalizeWeights, type SettingsBackend } from '@core/settings'
import { gatewayStickyKey, StickyStore } from '@core/routing/sticky'
import { DEFAULT_ROUTER_CONFIG } from '@core/routing/types'
import { makeHarness, type Harness } from '../routerHarness'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

describe('Stickiness (PRD §6)', () => {
  it('keeps using the model that last succeeded for a session, even when another now scores higher', async () => {
    h = await makeHarness()
    // Pinning once isn't sticky; a session's first auto request picks the top model.
    h.fake.script('fa', 'big-400b', { kind: 'status', status: 503 }, { kind: 'ok' })
    const first = await h.run({}, { stickyKey: 'session-1' })
    expect(first.start!.model).toBe('fb/alpha-120b') // big-400b failed once
    // big-400b is healthy again and would normally win, but the session stays on alpha.
    h.registry.recordOutcome('fa/big-400b', { state: 'healthy', latencyMs: 5 })
    h.health.success('fa/big-400b')
    for (let i = 0; i < 3; i++) h.health.record('fa/big-400b', true)
    expect((await h.run({}, { stickyKey: 'session-1' })).start!.model).toBe('fb/alpha-120b')
    // A different session (or none) is routed normally.
    expect((await h.run({}, { stickyKey: 'session-2' })).start!.model).toBe('fa/big-400b')
  })

  it('moves on when the sticky model fails, and sticks to the new one', async () => {
    h = await makeHarness()
    await h.run({}, { stickyKey: 's' })
    expect(h.sticky.get('s')).toBe('fa/big-400b')
    h.fake.script('fa', 'big-400b', { kind: 'status', status: 429 })
    const r = await h.run({}, { stickyKey: 's' })
    expect(r.start!.model).toBe('fb/alpha-120b')
    expect(h.sticky.get('s')).toBe('fb/alpha-120b')
  })

  it('ignores the sticky model when it no longer fits the request (e.g. tools needed)', async () => {
    h = await makeHarness()
    await h.run({ model: 'auto' }, { stickyKey: 's' })
    h.sticky.set('s', 'fb/beta-30b') // no tool support
    const r = await h.run({ tools: [{ type: 'function', function: { name: 'x' } }] }, { stickyKey: 's' })
    expect(r.start!.model).not.toBe('fb/beta-30b')
  })

  it('does not apply to pinned models or when disabled in settings', async () => {
    h = await makeHarness({ config: { stickiness: false } })
    await h.run({}, { stickyKey: 's' })
    expect(h.sticky.get('s')).toBeUndefined()
  })

  it('StickyStore expires idle sessions and caps its size', () => {
    let now = 0
    const s = new StickyStore(1000, () => now, 2)
    s.set('a', 'm1')
    now = 999
    expect(s.get('a')).toBe('m1')
    now = 2001
    expect(s.get('a')).toBeUndefined()
    s.set('x', '1')
    s.set('y', '2')
    s.set('z', '3')
    expect(s.get('x')).toBeUndefined()
    expect(s.get('z')).toBe('3')
  })

  it('gateway session key: explicit header wins; else system prompt + user-agent', () => {
    const msgs = [
      { role: 'system' as const, content: 'You are Cline' },
      { role: 'user' as const, content: 'task A' }
    ]
    const k1 = gatewayStickyKey(msgs, 'Cline/3.4')
    expect(k1).toBe(gatewayStickyKey([...msgs, { role: 'assistant', content: 'later turn' }], 'Cline/3.4'))
    expect(k1).not.toBe(gatewayStickyKey(msgs, 'Continue/1.0'))
    expect(gatewayStickyKey(msgs, 'x', 'my-session')).toBe('s:my-session')
    expect(gatewayStickyKey([], 'x')).toBeUndefined()
  })
})

describe('AppSettingsStore', () => {
  const backend = (): SettingsBackend & { data: Map<string, unknown> } => {
    const data = new Map<string, unknown>()
    return {
      data,
      get: <T>(k: string, f: T) => (data.has(k) ? (data.get(k) as T) : f),
      set: <T>(k: string, v: T) => (data.set(k, v), v)
    }
  }

  it('returns PRD defaults', () => {
    const s = new AppSettingsStore(backend()).get()
    expect(s.routing).toEqual(DEFAULT_ROUTING)
    expect(s.routing.weights).toEqual({ quality: 0.55, reliability: 0.2, speed: 0.15, headroom: 0.1 })
    expect(s).toMatchObject({ privateMode: false, logRetentionDays: 7, launchAtLogin: false, startMinimized: false, gatewayAllowedOrigins: [], autoUpdate: true, colorScheme: 'indigo' })
  })

  it('normalises weights, clamps maxPerProvider, and feeds the router config', () => {
    const store = new AppSettingsStore(backend())
    const s = store.update({ routing: { weights: { quality: 50, reliability: 25, speed: 25, headroom: 0 }, topN: 3, maxPerProvider: 5, ttftTimeoutMs: 8000 } })
    expect(s.routing.weights).toEqual({ quality: 0.5, reliability: 0.25, speed: 0.25, headroom: 0 })
    expect(s.routing.maxPerProvider).toBe(3)
    expect(store.routerConfig()).toMatchObject({ topN: 3, ttftTimeoutMs: 8000, degradedStreak: DEFAULT_ROUTER_CONFIG.degradedStreak })
    expect(store.resetRouting().routing).toEqual(DEFAULT_ROUTING)
  })

  it('stores the other settings independently', () => {
    const store = new AppSettingsStore(backend())
    store.update({ privateMode: true, startMinimized: true })
    expect(store.update({ logRetentionDays: 30 })).toMatchObject({ privateMode: true, startMinimized: true, logRetentionDays: 30 })
  })

  it('stores the colour scheme, and falls back to indigo for a scheme this version does not know', () => {
    const b = backend()
    const store = new AppSettingsStore(b)
    expect(store.update({ colorScheme: 'ocean' }).colorScheme).toBe('ocean')
    b.data.set('ui.colorScheme', 'some-future-scheme')
    expect(store.get().colorScheme).toBe('indigo')
  })

  it('zero weights fall back to defaults', () => {
    expect(normalizeWeights({ quality: 0, reliability: 0, speed: 0, headroom: 0 })).toEqual(DEFAULT_ROUTING.weights)
  })
})
