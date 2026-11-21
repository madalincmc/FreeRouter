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
import type { ProviderView, ThemePreference } from '@shared/ipc'
import { gatewayModels } from '@core/gateway/models'
import { toGatewayView } from '@core/routing/log'
import { GatewayController } from './gateway'
import { AppSettingsStore } from '@core/settings'
import { StickyStore } from '@core/routing/sticky'
import { UpdateController } from '@core/updates/controller'
import { createUpdater } from './updater'
import { openDatabase, SettingsStore, type Db } from './db'
import { safeStorageEncryptor } from './encryptor'
import { devDataDir, ensureDevKey, withDevProvider } from './devHooks'
import { emit, handle } from './ipc'
import { AppTray } from './tray'
import { createMainWindow, isTrustedSender } from './window'

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
    const appSettings = new AppSettingsStore(settings)
    const applyLoginItem = (): void => {
      // Only a packaged build registers itself; in dev it would register electron.exe.
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: appSettings.get().launchAtLogin, args: ['--hidden'] })
    }
    applyLoginItem()

    const applyTheme = (theme: ThemePreference): void => {
      nativeTheme.themeSource = theme
    }
    applyTheme(settings.get<ThemePreference>('ui.theme', 'dark'))

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
      log: (e) => {
        const id = requestLog.writeReturningId(e)
        if (e.source === 'gateway') emit(mainWindow?.webContents, 'gateway:request', toGatewayView({ ...e, id }))
      },
      quota,
      health: new HealthTracker(),
      sticky: new StickyStore(),
      fetch: httpFetch,
      // Read per request, so Settings changes apply to the next request.
      config: () => appSettings.routerConfig()
    })
    // ---- Chat (M4) ----
    const conversations = new ConversationStore(db)
    conversations.recoverInterrupted()
    const chat = new ChatService({
      store: conversations,
      route: (req, opts) => router.route(req, opts),
      emit: (e) => emit(mainWindow?.webContents, 'chat:event', e),
      privateMode: () => appSettings.get().privateMode
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

    // ---- Gateway (M5) – local OpenAI-compatible endpoint ----
    const gateway = new GatewayController(
      {
        route: (req, opts) => router.route(req, opts),
        listModels: () => gatewayModels(registry.list(), listProviders(), chains.list().map((c) => c.name)),
        healthyCount: () => countRoutable(registry.list(), listProviders()),
        allowedOrigins: () => appSettings.get().gatewayAllowedOrigins,
        privateMode: () => appSettings.get().privateMode,
        version: app.getVersion()
      },
      settings,
      safeStorageEncryptor,
      (status) => {
        tray?.refresh()
        emit(mainWindow?.webContents, 'gateway:statusChanged', status)
      }
    )
    await gateway.init()
    app.on('will-quit', () => void gateway.stop())
    handle('gateway:getStatus', isTrustedSender, () => gateway.status())
    handle('gateway:setEnabled', isTrustedSender, (enabled) => gateway.setEnabled(enabled))
    handle('gateway:setPort', isTrustedSender, (port) => gateway.setPort(port))
    handle('gateway:getToken', isTrustedSender, () => gateway.getToken())
    handle('gateway:regenerateToken', isTrustedSender, () => gateway.regenerateToken())
    handle('gateway:recentRequests', isTrustedSender, (limit) => requestLog.recentGateway(limit))

    // Metadata-only request log, kept 7 days by default (PRD §10).
    const pruneLog = (): number => requestLog.prune(Date.now() - appSettings.get().logRetentionDays * 24 * 3600_000)
    pruneLog()
    setInterval(pruneLog, 6 * 3600_000).unref()

    // ---- Settings & chains (M6) ----
    handle('settings:get', isTrustedSender, () => appSettings.get())
    handle('settings:update', isTrustedSender, (patch) => {
      const next = appSettings.update(patch)
      if (patch.launchAtLogin !== undefined) applyLoginItem()
      if (patch.logRetentionDays !== undefined) pruneLog()
      return next
    })
    handle('settings:resetRouting', isTrustedSender, () => appSettings.resetRouting())
    const listChains = () => chains.list().map((c) => ({ name: c.name, modelIds: c.modelIds }))
    handle('chains:list', isTrustedSender, listChains)
    handle('chains:save', isTrustedSender, (name, modelIds) => {
      chains.save(name, modelIds)
      return listChains()
    })
    handle('chains:delete', isTrustedSender, (name) => {
      chains.delete(name)
      return listChains()
    })

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
    handle('settings:getTheme', isTrustedSender, () => settings.get<ThemePreference>('ui.theme', 'dark'))
    handle('settings:setTheme', isTrustedSender, (theme) => {
      applyTheme(theme)
      return settings.set('ui.theme', theme)
    })

    // ---- Auto-update: GitHub Releases via electron-updater, packaged builds only ----
    const updates = new UpdateController({
      currentVersion: app.getVersion(),
      supported: app.isPackaged,
      updater: createUpdater,
      autoCheck: () => appSettings.get().autoUpdate,
      onChange: (status) => {
        tray?.refresh()
        emit(mainWindow?.webContents, 'updates:status', status)
      }
    })
    handle('updates:getStatus', isTrustedSender, () => updates.status())
    handle('updates:check', isTrustedSender, () => updates.check())
    handle('updates:install', isTrustedSender, () => updates.install())
    updates.start()

    tray = new AppTray(join(resourcesDir, 'tray.png'), {
      open: showWindow,
      toggleGateway: () => void gateway.setEnabled(!gateway.status().enabled),
      quit: () => app.quit(),
      gatewayStatus: () => gateway.status(),
      healthyModelCount: () => countRoutable(registry.list(), listProviders()),
      updateStatus: () => updates.status(),
      installUpdate: () => updates.install()
    })

    // Launched at login (--hidden) or "start minimised": live in the tray, gateway already up.
    const hidden = process.argv.includes('--hidden') || appSettings.get().startMinimized
    if (!hidden) showWindow()

    // Sync at startup (cached registry is served meanwhile), then every 6 hours (PRD §5).
    void runSync()
    setInterval(() => void runSync(), SYNC_INTERVAL_MS).unref()
  })

  // Tray app: stay alive when all windows are closed.
  app.on('window-all-closed', () => {})
}
