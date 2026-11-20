import type { ModelView, ProviderView } from '@shared/ipc'
import { VIRTUAL_MODELS } from '../chat/options'
import { isRoutable } from '../registry/routable'
import type { GatewayModel } from './server'

/** GET /v1/models: virtual models, chains, then every currently routable concrete model (PRD §8). */
export function gatewayModels(models: ModelView[], providers: ProviderView[], chains: string[]): GatewayModel[] {
  const byId = new Map(providers.map((p) => [p.id, p]))
  return [
    ...VIRTUAL_MODELS.map((v) => ({ id: v.value, owned_by: 'freerouter' })),
    ...chains.map((c) => ({ id: `chain:${c}`, owned_by: 'freerouter' })),
    ...models
      .filter((m) => isRoutable(m, byId.get(m.providerId)))
      .sort((a, b) => (b.quality.general ?? 0) - (a.quality.general ?? 0))
      .map((m) => ({ id: m.id, owned_by: m.providerId, context_length: m.contextWindow }))
  ]
}
