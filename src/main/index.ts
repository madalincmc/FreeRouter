import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, session } from 'electron'
import { redactError } from '@core/security/redact'
import type { GatewayStatus, ThemePreference } from '@shared/ipc'
import { openDatabase, SettingsStore, type Db } from './db'
import { emit, handle } from './ipc'
import { AppTray } from './tray'
import { createMainWindow, isTrustedSender } from './window'

const DEFAULT_GATEWAY_PORT = 4141

// All state lives in %APPDATA%/FreeRouter (PRD §10).
app.setPath('userData', join(app.getPath('appData'), 'FreeRouter'))
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

  void app.whenReady().then(() => {
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

    handle('app:getInfo', isTrustedSender, () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: `${process.platform}-${process.arch}`,
      dataDir: app.getPath('userData'),
      schemaVersion: opened.schemaVersion
    }))
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
      healthyModelCount: () => 0 // registry arrives in M2
    })

    showWindow()
  })

  // Tray app: stay alive when all windows are closed.
  app.on('window-all-closed', () => {})
}
