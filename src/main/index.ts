import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { KeyService } from '@core/keys/service'
import { KeyVault } from '@core/keys/vault'
import { bundledCatalog } from '@core/providers/catalog'
import { ProviderStore } from '@core/providers/store'
import type { FetchLike } from '@core/http'
import { countRoutable } from '@core/registry/routable'
import { ModelRegistry } from '@core/registry/store'
import { RegistryService, SYNC_INTERVAL_MS } from '@core/registry/sync'
import { ChainStore } from '@core/routing/chains'
import { HealthTracker } from '@core/routing/health'
import { RequestLog } from '@core/routing/log'
import { QuotaTracker } from '@core/routing/quota'
import { Router } from '@core/routing/router'
import { modelOptions } from '@core/chat/options'
import { ChatService } from '@core/chat/service'
import { ConversationStore } from '@core/chat/store'
import { redactError } from '@core/security/redact'
import type { GatewayStatus, ProviderView, ThemePreference } from '@shared/ipc'
import { openDatabase, SettingsStore, type Db } from './db'
import { safeStorageEncryptor } from './encryptor'
import { devDataDir, ensureDevKey, withDevProvider } from './devHooks'
import { emit, handle } from './ipc'
import { AppTray } from './tray'
import { createMainWindow, isTrustedSender } from './window'

const DEFAULT_GATEWAY_PORT = 4141

// All state lives in %APPDATA%/FreeRouter (PRD §10); dev builds may point elsewhere.
app.setPath('userData', devDataDir() ?? join(app.getPath('appData'), 'FreeRouter'))
app.setAppUserModelId('com.freerouter.desktop')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | undefined
  let tray: AppTray | undefined
  let db: Db | undefined
  let quitting = false

  const resourcesDir = join(import.meta.dirname, '../../resources')
  const iconPath = join(resourcesDir, 'icon.png')

  const showWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow(iconPath)
      // Closing the window keeps the app (and later the gateway) running in the tray.
      mainWindow.on('close', (e) => {
        if (!quitting) {
          e.preventDefault()
          mainWindow?.hide()
        }
      })
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }

  app.on('second-instance', showWindow)

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', () => {
    tray?.destroy()
    db?.close()
  })

  process.on('uncaughtException', (err) => console.error('[main] uncaught:', redactError(err)))
  process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection:', redactError(err)))

  void app.whenReady().then(async () => {
    // Deny every permission request (camera, mic, notifications…) – the renderer needs none.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))

    const opened = openDatabase(app.getPath('userData'))
    db = opened.db
    const settings = new SettingsStore(db)

    const gatewayStatus = (): GatewayStatus => ({
      enabled: settings.get('gateway.enabled', true),
      port: settings.get('gateway.port', DEFAULT_GATEWAY_PORT),
      running: false // the Fastify gateway arrives in M5
    })

    const applyTheme = (theme: ThemePreference): void => {
      nativeTheme.themeSource = theme
    }
    applyTheme(settings.get<ThemePreference>('ui.theme', 'dark'))

    const setGatewayEnabled = (enabled: boolean): GatewayStatus => {
      settings.set('gateway.enabled', enabled)
      const status = gatewayStatus()
      tray?.refresh()
      emit(mainWindow?.webContents, 'gateway:statusChanged', status)
      return status
    }

    // ---- Providers & keys (M1) ----
    const catalog = withDevProvider(bundledCatalog)
    const providers = new ProviderStore(db, catalog)
    providers.seed()
    const vault = new KeyVault(db, safeStorageEncryptor)
    await ensureDevKey(vault, catalog)
    const httpFetch: FetchLike = (url, init) => fetch(url, init)
    const keys = new KeyService(vault, providers, { fetch: httpFetch, timeoutMs: 10_000 })
    const listProviders = (): ProviderView[] => providers.list((id) => vault.list(id))

    // ---- Model registry (M2) ----
    const registry = new ModelRegistry(db)
    const registryService = new RegistryService({ registry, providers, vault, fetch: httpFetch })
    const modelsChanged = (reason: 'sync' | 'test' | 'edit'): void => {
      tray?.refresh()
      emit(mainWindow?.webContents, 'models:changed', { reason })
    }
    // ---- Router (M3) – consumed by the chat UI (M4) and the gateway (M5) ----
    const quota = new QuotaTracker(db)
    const requestLog = new RequestLog(db)
    const chains = new ChainStore(db)
    const router = new Router({
      snapshot: () => ({ models: registry.list(), providers: listProviders() }),
      profile: (id) => providers.profile(id),
      revealKey: (id) => vault.reveal(id),
      markKeyInvalid: (id) => vault.setStatus(id, 'invalid'),
      recordModelOutcome: (id, outcome) => {
        registry.recordOutcome(id, outcome)
        modelsChanged('test')
      },
      chains: (name) => chains.get(name),
      log: (e) => requestLog.write(e),
      quota,
      health: new HealthTracker(),
      fetch: httpFetch
    })
    // ---- Chat (M4) ----
    const conversations = new ConversationStore(db)
    conversations.recoverInterrupted()
    const chat = new ChatService({
      store: conversations,
      route: (req, opts) => router.route(req, opts),
      emit: (e) => emit(mainWindow?.webContents, 'chat:event', e)
    })
    app.on('before-quit', () => chat.stopAll())
    handle('chat:list', isTrustedSender, () => conversations.list())
    handle('chat:get', isTrustedSender, (id) => conversations.get(id))
    handle('chat:create', isTrustedSender, () => conversations.create())
    handle('chat:rename', isTrustedSender, (id, title) => conversations.rename(id, title))
    handle('chat:delete', isTrustedSender, (id) => {
      for (const m of conversations.messages(id)) chat.stop(m.id)
      return conversations.delete(id)
    })
    handle('chat:setOptions', isTrustedSender, (id, o) => conversations.setOptions(id, o))
    handle('chat:send', isTrustedSender, (id, text) => chat.send(id, text))
    handle('chat:regenerate', isTrustedSender, (id, model) => chat.regenerate(id, model))
    handle('chat:continue', isTrustedSender, (id, messageId) => chat.continue(id, messageId))
    handle('chat:stop', isTrustedSender, (messageId) => chat.stop(messageId))
    handle('chat:modelOptions', isTrustedSender, () =>
      modelOptions(registry.list(), listProviders(), chains.list().map((c) => c.name))
    )

    // Metadata-only request log, kept 7 days by default (PRD §10).
    requestLog.prune(Date.now() - settings.get('log.retentionDays', 7) * 24 * 3600_000)

    const runSync = async (providerId?: string) => {
      const results = await registryService.sync(providerId)
      for (const r of results) if (r.outcome === 'error') console.warn(`[registry] ${r.providerId}: ${r.message}`)
      modelsChanged('sync')
      return results
    }

    handle('app:getInfo', isTrustedSender, async () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: `${process.platform}-${process.arch}`,
      dataDir: app.getPath('userData'),
      schemaVersion: opened.schemaVersion,
      encryptionAvailable: await vault.isAvailable()
    }))
    handle('providers:list', isTrustedSender, listProviders)
    handle('providers:setEnabled', isTrustedSender, (id, enabled) => {
      providers.setEnabled(id, enabled)
      return listProviders()
    })
    handle('providers:setLimitOverrides', isTrustedSender, (id, overrides) => {
      providers.setLimitOverrides(id, overrides)
      return listProviders()
    })
    handle('keys:add', isTrustedSender, async (input) => {
      const result = await keys.add(input)
      // A new key may unlock a provider's model list: sync it in the background.
      if (result.saved) void runSync(input.providerId)
      return result
    })
    handle('keys:test', isTrustedSender, (keyId) => keys.test(keyId))
    handle('keys:setEnabled', isTrustedSender, (keyId, enabled) => {
      vault.setEnabled(keyId, enabled)
      return listProviders()
    })
    handle('keys:delete', isTrustedSender, (keyId) => {
      vault.delete(keyId)
      return listProviders()
    })
    handle('models:list', isTrustedSender, () => registry.list())
    handle('models:syncStatus', isTrustedSender, () => registry.syncStatus(listProviders().map((p) => p.id)))
    handle('models:sync', isTrustedSender, (providerId) => runSync(providerId))
    handle('models:setEnabled', isTrustedSender, (id, enabled) => {
      const m = registry.setEnabled(id, enabled)
      modelsChanged('edit')
      return m
    })
    handle('models:setQuality', isTrustedSender, (id, quality) => registry.setQualityOverride(id, quality))
    handle('models:usageToday', isTrustedSender, () => {
      const keyProvider = new Map(vault.list().map((k) => [k.id, k.providerId]))
      return quota.todayByModel((keyId) => keyProvider.get(keyId))
    })
    handle('models:test', isTrustedSender, async (id) => {
      const r = await registryService.testModel(id)
      modelsChanged('test')
      return r
    })
    handle('gateway:getStatus', isTrustedSender, gatewayStatus)
    handle('gateway:setEnabled', isTrustedSender, setGatewayEnabled)
    handle('settings:getTheme', isTrustedSender, () => settings.get<ThemePreference>('ui.theme', 'dark'))
    handle('settings:setTheme', isTrustedSender, (theme) => {
      applyTheme(theme)
      return settings.set('ui.theme', theme)
    })

    tray = new AppTray(join(resourcesDir, 'tray.png'), {
      open: showWindow,
      toggleGateway: () => setGatewayEnabled(!gatewayStatus().enabled),
      quit: () => app.quit(),
      gatewayStatus,
      healthyModelCount: () => countRoutable(registry.list(), listProviders())
    })

    showWindow()

    // Sync at startup (cached registry is served meanwhile), then every 6 hours (PRD §5).
    void runSync()
    setInterval(() => void runSync(), SYNC_INTERVAL_MS).unref()
  })

  // Tray app: stay alive when all windows are closed.
  app.on('window-all-closed', () => {})
}
