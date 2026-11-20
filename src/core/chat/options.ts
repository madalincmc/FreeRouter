import type { ModelOptions, ModelView, ProviderView } from '@shared/ipc'
import { isRoutable } from '../registry/routable'

export const VIRTUAL_MODELS: ModelOptions['virtual'] = [
  { value: 'auto', label: 'Auto', hint: 'Best free model for the request' },
  { value: 'auto:coding', label: 'Auto · coding', hint: 'Prefers coding-strong models' },
  { value: 'auto:reasoning', label: 'Auto · reasoning', hint: 'Prefers reasoning models' },
  { value: 'auto:fast', label: 'Auto · fast', hint: 'Prefers the lowest latency' },
  { value: 'auto:long', label: 'Auto · long context', hint: 'Only long-context models' }
]

/** What the chat model picker offers: virtual models, chains and currently routable models. */
export function modelOptions(models: ModelView[], providers: ProviderView[], chains: string[]): ModelOptions {
  const byId = new Map(providers.map((p) => [p.id, p]))
  return {
    virtual: VIRTUAL_MODELS,
    chains,
    models: models
      .filter((m) => isRoutable(m, byId.get(m.providerId)))
      .sort((a, b) => (b.quality.general ?? 0) - (a.quality.general ?? 0))
      .map((m) => ({ id: m.id, label: m.displayName, provider: byId.get(m.providerId)?.name ?? m.providerId, tags: m.tags }))
  }
}
