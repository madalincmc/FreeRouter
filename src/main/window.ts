import { join } from 'node:path'
import { BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'

const DEV_URL = process.env['ELECTRON_RENDERER_URL']

/** Origin the renderer is served from: the Vite dev server in dev, file:// in production. */
export function isTrustedUrl(url: string): boolean {
  if (DEV_URL) return url.startsWith(new URL(DEV_URL).origin + '/')
  return url.startsWith('file://') && decodeURIComponent(url).replace(/\\/g, '/').includes('/out/renderer/')
}

export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url
  return typeof url === 'string' && isTrustedUrl(url)
}

function isSafeExternal(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

export function createMainWindow(iconPath: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'FreeRouter',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // External links open in the system browser; the app never opens new Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // No navigation away from the app's own renderer.
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return
    event.preventDefault()
    if (isSafeExternal(url)) void shell.openExternal(url)
  })

  if (DEV_URL) void win.loadURL(DEV_URL)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))

  return win
}
