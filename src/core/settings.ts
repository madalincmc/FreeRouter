import type { AppSettings, RoutingSettings } from '@shared/ipc'
import { DEFAULT_ROUTER_CONFIG, type RouterConfig } from './routing/types'

/** Minimal key/value interface (SettingsStore in main, a Map in tests). */
export interface SettingsBackend {
  get<T>(key: string, fallback: T): T
  set<T>(key: string, value: T): T
}

export const DEFAULT_ROUTING: RoutingSettings = {
  weights: { ...DEFAULT_ROUTER_CONFIG.weights },
  topN: DEFAULT_ROUTER_CONFIG.topN,
  maxPerProvider: DEFAULT_ROUTER_CONFIG.maxPerProvider,
  ttftTimeoutMs: DEFAULT_ROUTER_CONFIG.ttftTimeoutMs,
  totalTimeoutMs: DEFAULT_ROUTER_CONFIG.totalTimeoutMs,
  allowFallbackWhenPinned: DEFAULT_ROUTER_CONFIG.allowFallbackWhenPinned,
  minToolsQuality: DEFAULT_ROUTER_CONFIG.minToolsQuality,
  stickiness: DEFAULT_ROUTER_CONFIG.stickiness
}

const KEYS = {
  routing: 'router.config',
  privateMode: 'privacy.privateMode',
  logRetentionDays: 'log.retentionDays',
  launchAtLogin: 'app.launchAtLogin',
  startMinimized: 'app.startMinimized',
  gatewayAllowedOrigins: 'gateway.allowedOrigins',
  autoUpdate: 'app.autoUpdate'
} as const

/** Normalises weights to sum to 1 (the UI edits them as relative values). */
export function normalizeWeights(w: RoutingSettings['weights']): RoutingSettings['weights'] {
  const sum = w.quality + w.reliability + w.speed + w.headroom
  if (!(sum > 0)) return { ...DEFAULT_ROUTING.weights }
  const r = (n: number) => Math.round((n / sum) * 1000) / 1000
  return { quality: r(w.quality), reliability: r(w.reliability), speed: r(w.speed), headroom: r(w.headroom) }
}

/** Typed app settings on top of the `settings` table (PRD §9 Settings screen). */
export class AppSettingsStore {
  constructor(private readonly b: SettingsBackend) {}

  get(): AppSettings {
    const stored = this.b.get<Partial<RoutingSettings>>(KEYS.routing, {})
    return {
      routing: { ...DEFAULT_ROUTING, ...stored, weights: { ...DEFAULT_ROUTING.weights, ...(stored.weights ?? {}) } },
      privateMode: this.b.get(KEYS.privateMode, false),
      logRetentionDays: this.b.get(KEYS.logRetentionDays, 7),
      launchAtLogin: this.b.get(KEYS.launchAtLogin, false),
      startMinimized: this.b.get(KEYS.startMinimized, false),
      gatewayAllowedOrigins: this.b.get<string[]>(KEYS.gatewayAllowedOrigins, []),
      autoUpdate: this.b.get(KEYS.autoUpdate, true)
    }
  }

  update(patch: Partial<Omit<AppSettings, 'routing'>> & { routing?: Partial<RoutingSettings> }): AppSettings {
    const cur = this.get()
    if (patch.routing) {
      const routing = { ...cur.routing, ...patch.routing }
      if (patch.routing.weights) routing.weights = normalizeWeights({ ...cur.routing.weights, ...patch.routing.weights })
      // Never fewer candidates than one, never more per provider than candidates.
      routing.maxPerProvider = Math.min(routing.maxPerProvider, routing.topN)
      this.b.set(KEYS.routing, routing)
    }
    for (const k of ['privateMode', 'logRetentionDays', 'launchAtLogin', 'startMinimized', 'gatewayAllowedOrigins', 'autoUpdate'] as const) {
      if (patch[k] !== undefined) this.b.set(KEYS[k], patch[k])
    }
    return this.get()
  }

  resetRouting(): AppSettings {
    this.b.set(KEYS.routing, {})
    return this.get()
  }

  /** The router's full config: defaults plus the user's routing settings. */
  routerConfig(): RouterConfig {
    return { ...DEFAULT_ROUTER_CONFIG, ...this.get().routing }
  }
}
