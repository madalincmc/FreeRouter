import electronUpdater from 'electron-updater'
import { redact } from '@core/security/redact'
import type { UpdaterLike } from '@core/updates/controller'

/**
 * The real updater. It reads the feed from `app-update.yml`, which electron-builder writes from
 * the `publish` block in electron-builder.yml (GitHub Releases), and checks each download's
 * sha512 against `latest.yml`.
 */
export function createUpdater(): UpdaterLike {
  // electron-updater is CommonJS; its named exports come through the default import under ESM.
  const { autoUpdater } = electronUpdater
  const log =
    (level: 'info' | 'warn' | 'error') =>
    (msg: unknown): void =>
      console[level]('[updater]', redact(msg instanceof Error ? `${msg.name}: ${msg.message}` : String(msg)))
  autoUpdater.logger = { info: log('info'), warn: log('warn'), error: log('error'), debug: () => {} }
  return autoUpdater
}
