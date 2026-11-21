import type { UpdateStatus } from '@shared/ipc'
import { redactError } from '../security/redact'

/**
 * The slice of electron-updater's `AppUpdater` the controller uses. Main passes the real
 * `autoUpdater`; tests pass a fake. Keeping this an interface keeps core free of Electron.
 */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available', listener: (info: { version: string }) => void): unknown
  on(event: 'update-not-available', listener: (info: { version: string }) => void): unknown
  on(event: 'download-progress', listener: (p: { percent: number }) => void): unknown
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateControllerDeps {
  currentVersion: string
  /** Only packaged builds can update; dev and unpacked runs report `disabled`. */
  supported: boolean
  /** Created lazily so dev builds never load electron-updater. */
  updater: () => UpdaterLike
  /** Read on every scheduled tick, so the Settings toggle applies immediately. */
  autoCheck: () => boolean
  onChange: (status: UpdateStatus) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void }
  setRepeat?: (fn: () => void, ms: number) => { unref?: () => void }
}

/** First automatic check after startup: late enough not to compete with the registry sync. */
export const FIRST_CHECK_DELAY_MS = 60_000
export const CHECK_INTERVAL_MS = 6 * 3600_000

/**
 * Background auto-update: check on a schedule, download silently, then wait for the user to
 * restart (a tray app rarely quits on its own). The update also installs on the next quit.
 */
export class UpdateController {
  private s: UpdateStatus
  private u: UpdaterLike | undefined
  private readonly now: () => number

  constructor(private readonly d: UpdateControllerDeps) {
    this.now = d.now ?? Date.now
    this.s = {
      state: d.supported ? 'idle' : 'disabled',
      currentVersion: d.currentVersion,
      availableVersion: null,
      percent: null,
      checkedAt: null,
      error: null
    }
  }

  status(): UpdateStatus {
    return { ...this.s }
  }

  /** Schedules automatic checks. No-op in unsupported (dev) builds. */
  start(): void {
    if (!this.d.supported) return
    const tick = (): void => {
      if (this.d.autoCheck()) void this.check()
    }
    const setTimer = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const setRepeat = this.d.setRepeat ?? ((fn, ms) => setInterval(fn, ms))
    setTimer(tick, FIRST_CHECK_DELAY_MS).unref?.()
    setRepeat(tick, CHECK_INTERVAL_MS).unref?.()
  }

  /** Checks now (Settings "Check now", or the schedule). Never throws. */
  async check(): Promise<UpdateStatus> {
    if (!this.d.supported) return this.status()
    // Once an update is downloading or downloaded there is nothing new to learn.
    if (this.s.state === 'checking' || this.s.state === 'downloading' || this.s.state === 'ready') return this.status()
    this.set({ state: 'checking', error: null })
    try {
      await this.updater().checkForUpdates()
    } catch (err) {
      this.fail(err)
    }
    return this.status()
  }

  /** Restarts into the downloaded update. Returns false when none is ready. */
  install(): boolean {
    if (this.s.state !== 'ready' || !this.u) return false
    // Silent install of the assisted NSIS installer, then relaunch the app.
    this.u.quitAndInstall(true, true)
    return true
  }

  private updater(): UpdaterLike {
    if (this.u) return this.u
    const u = this.d.updater()
    u.autoDownload = true
    u.autoInstallOnAppQuit = true
    u.on('checking-for-update', () => this.set({ state: 'checking' }))
    u.on('update-available', (info) => this.set({ state: 'downloading', availableVersion: info.version, percent: 0 }))
    u.on('update-not-available', () => this.set({ state: 'up-to-date', availableVersion: null, percent: null, checkedAt: this.now() }))
    u.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent))) }))
    u.on('update-downloaded', (info) => this.set({ state: 'ready', availableVersion: info.version, percent: 100, checkedAt: this.now() }))
    u.on('error', (err) => this.fail(err))
    this.u = u
    return u
  }

  private fail(err: unknown): void {
    // A failed check or download leaves the app usable; the next scheduled check retries.
    // electron-updater errors can carry whole HTTP bodies; the UI gets the first line only.
    const message = (redactError(err).split('\n')[0] ?? '').slice(0, 300)
    this.set({ state: 'error', error: message, percent: null, checkedAt: this.now() })
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.s = { ...this.s, ...patch }
    this.d.onChange(this.status())
  }
}
