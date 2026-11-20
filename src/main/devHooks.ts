import { app } from 'electron'
import { parseCatalog, type Catalog } from '@core/providers/catalog'
import type { KeyVault } from '@core/keys/vault'

/**
 * Development-only hooks for end-to-end checks without real provider keys. They are ignored in
 * packaged builds.
 *
 * - FREEROUTER_DATA_DIR: use a separate data folder (never touch the real profile)
 * - FREEROUTER_DEV_FAKE_PROVIDER: base URL of the fake OpenAI-compatible server from
 *   tests/fakeProvider.ts; adds a "devfake" provider whose models live at <url>/devfake/v1
 */
export const devEnabled = (): boolean => !app.isPackaged

export function devDataDir(): string | undefined {
  return devEnabled() ? process.env['FREEROUTER_DATA_DIR'] || undefined : undefined
}

export function withDevProvider(catalog: Catalog): Catalog {
  const url = devEnabled() ? process.env['FREEROUTER_DEV_FAKE_PROVIDER'] : undefined
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return catalog
  return parseCatalog({
    ...catalog,
    providers: [
      ...catalog.providers,
      {
        id: 'devfake',
        name: 'Dev fake provider',
        baseUrl: `${url}/devfake/v1`,
        keyUrl: 'https://example.com',
        docsUrl: 'https://example.com',
        mayTrainOnData: false,
        limitScope: 'organization',
        keyRotation: true,
        limits: {},
        notes: 'Local fake provider for development (FREEROUTER_DEV_FAKE_PROVIDER).',
        validation: { url: `${url}/devfake/v1/models`, invalidStatuses: [401, 403] },
        models: {
          auth: 'required',
          listPath: 'data',
          fields: { id: 'id', contextWindow: 'context_length', supportedParameters: 'supported_parameters' },
          free: { all: true },
          exclude: []
        }
      }
    ]
  })
}

export async function ensureDevKey(vault: KeyVault, catalog: Catalog): Promise<void> {
  if (!catalog.providers.some((p) => p.id === 'devfake')) return
  if (vault.list('devfake').length === 0) {
    await vault.add({ providerId: 'devfake', label: 'dev', key: 'sk-devfake-0123456789abcdef', status: 'valid' })
  }
}
