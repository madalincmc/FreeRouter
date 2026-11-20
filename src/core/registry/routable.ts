import type { ModelView, ProviderView } from '@shared/ipc'
import { usableKey } from './sync'

/**
 * Whether a model can be routed to right now, ignoring per-request needs (context, tools, …),
 * which the M3 router adds on top: free, enabled, healthy or degraded, provider enabled with a usable key.
 */
export function isRoutable(m: ModelView, provider: ProviderView | undefined): boolean {
  return (
    !!provider &&
    provider.enabled &&
    !!usableKey(provider.keys) &&
    m.isFree &&
    m.enabled &&
    (m.state === 'healthy' || m.state === 'degraded')
  )
}

export function countRoutable(models: ModelView[], providers: ProviderView[]): number {
  const byId = new Map(providers.map((p) => [p.id, p]))
  return models.filter((m) => isRoutable(m, byId.get(m.providerId))).length
}
