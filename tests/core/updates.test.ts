import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, UpdateController, type UpdaterLike } from '@core/updates/controller'
import type { UpdateStatus } from '@shared/ipc'

/** A scripted stand-in for electron-updater's autoUpdater. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  checks = 0
  installed: [boolean | undefined, boolean | undefined] | null = null
  next: (u: FakeUpdater) => void = (u) => u.emit('update-not-available', { version: '1.0.0' })

  async checkForUpdates(): Promise<unknown> {
    this.checks++
    this.next(this)
    return null
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installed = [isSilent, isForceRunAfter]
  }
}

function setup(opts: { supported?: boolean; autoCheck?: boolean } = {}) {
  const fake = new FakeUpdater()
  const events: UpdateStatus[] = []
  const timers: { ms: number; fn: () => void; repeat: boolean }[] = []
  let created = 0
  const c = new UpdateController({
    currentVersion: '1.0.0',
    supported: opts.supported ?? true,
    updater: () => {
      created++
      return fake
    },
    autoCheck: () => opts.autoCheck ?? true,
    onChange: (s) => events.push(s),
    now: () => 42,
    setTimer: (fn, ms) => (timers.push({ fn, ms, repeat: false }), {}),
    setRepeat: (fn, ms) => (timers.push({ fn, ms, repeat: true }), {})
  })
  return { c, fake, events, timers, created: () => created }
}

describe('UpdateController', () => {
  it('is disabled in dev builds and never creates the updater', async () => {
    const t = setup({ supported: false })
    expect(t.c.status().state).toBe('disabled')
    t.c.start()
    expect(t.timers).toHaveLength(0)
    expect((await t.c.check()).state).toBe('disabled')
    expect(t.created()).toBe(0)
    expect(t.c.install()).toBe(false)
  })

  it('reports up-to-date and enables background download on first use', async () => {
    const t = setup()
    const s = await t.c.check()
    expect(s).toMatchObject({ state: 'up-to-date', checkedAt: 42, error: null })
    expect(t.fake.autoDownload).toBe(true)
    expect(t.fake.autoInstallOnAppQuit).toBe(true)
    expect(t.events.map((e) => e.state)).toEqual(['checking', 'up-to-date'])
  })

  it('downloads an update, reports progress, then installs silently and relaunches', async () => {
    const t = setup()
    t.fake.next = (u) => {
      u.emit('update-available', { version: '1.1.0' })
      u.emit('download-progress', { percent: 41.6 })
    }
    expect(await t.c.check()).toMatchObject({ state: 'downloading', availableVersion: '1.1.0', percent: 42 })
    expect(t.c.install()).toBe(false) // not downloaded yet

    // A check while downloading doesn't start another one.
    await t.c.check()
    expect(t.fake.checks).toBe(1)

    t.fake.emit('update-downloaded', { version: '1.1.0' })
    expect(t.c.status()).toMatchObject({ state: 'ready', availableVersion: '1.1.0', percent: 100 })
    expect(t.c.install()).toBe(true)
    expect(t.fake.installed).toEqual([true, true])
  })

  it('turns failures into a redacted one-line error, and can check again', async () => {
    const t = setup()
    t.fake.checkForUpdates = async () => {
      throw new Error('HttpError: 404\nauthorization: token ghp_abcdefghijklmnop1234\n<html>…</html>')
    }
    const s = await t.c.check()
    expect(s.state).toBe('error')
    expect(s.error).toBe('Error: HttpError: 404')
    expect(JSON.stringify(t.events)).not.toContain('ghp_abcdefghijklmnop1234')

    t.fake.checkForUpdates = FakeUpdater.prototype.checkForUpdates
    expect((await t.c.check()).state).toBe('up-to-date')
  })

  it('error events from the updater (e.g. a failed download) are redacted too', async () => {
    const t = setup()
    await t.c.check()
    t.fake.emit('error', new Error('download failed for key=AIzaSyA1234567890abcdef'))
    expect(t.c.status().state).toBe('error')
    expect(t.c.status().error).not.toContain('AIzaSyA1234567890abcdef')
  })

  it('schedules a delayed first check and a 6-hourly check, honouring the setting on each tick', async () => {
    let auto = false
    const t = setup()
    const c = new UpdateController({
      currentVersion: '1.0.0',
      supported: true,
      updater: () => t.fake,
      autoCheck: () => auto,
      onChange: () => {},
      setTimer: (fn, ms) => (t.timers.push({ fn, ms, repeat: false }), {}),
      setRepeat: (fn, ms) => (t.timers.push({ fn, ms, repeat: true }), {})
    })
    c.start()
    expect(t.timers.map((x) => [x.ms, x.repeat])).toEqual([
      [FIRST_CHECK_DELAY_MS, false],
      [CHECK_INTERVAL_MS, true]
    ])
    t.timers[0]!.fn()
    expect(t.fake.checks).toBe(0) // auto-update off
    auto = true
    t.timers[1]!.fn()
    await Promise.resolve()
    expect(t.fake.checks).toBe(1)
  })
})
