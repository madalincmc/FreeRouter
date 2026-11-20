import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { KeyStatus, KeyView } from '@shared/ipc'
import { maskKey } from '../security/redact'

/**
 * Encryption backend. In the app this is Electron's async safeStorage (DPAPI-protected on
 * Windows); tests inject a fake. The vault refuses to store anything when it is unavailable.
 */
export interface Encryptor {
  isAvailable(): Promise<boolean>
  encrypt(plaintext: string): Promise<Buffer>
  /** `shouldReEncrypt` is set when the OS key was rotated; the vault then re-encrypts. */
  decrypt(ciphertext: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('OS-level encryption (DPAPI) is not available, so keys cannot be stored safely')
    this.name = 'EncryptionUnavailableError'
  }
}

export class DuplicateKeyError extends Error {
  constructor() {
    super('This key is already saved for this provider')
    this.name = 'DuplicateKeyError'
  }
}

interface KeyRow {
  id: string
  provider_id: string
  label: string
  masked: string
  status: KeyStatus
  enabled: number
  created_at: number
  last_ok_at: number | null
}

const VIEW_COLUMNS = 'id, provider_id, label, masked, status, enabled, created_at, last_ok_at'

const toView = (r: KeyRow): KeyView => ({
  id: r.id,
  providerId: r.provider_id,
  label: r.label,
  masked: r.masked,
  status: r.status,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  lastOkAt: r.last_ok_at
})

export interface KeyVaultOptions {
  now?: () => number
  newId?: () => string
}

/**
 * Encrypted API key storage (PRD §7). Only `reveal()` returns plaintext and it must only be
 * called in the main process at request time. Every other method returns masked views.
 */
export class KeyVault {
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    private readonly db: Database.Database,
    private readonly enc: Encryptor,
    opts: KeyVaultOptions = {}
  ) {
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? randomUUID
  }

  isAvailable(): Promise<boolean> {
    return this.enc.isAvailable()
  }

  async add(input: { providerId: string; label: string; key: string; status: KeyStatus }): Promise<KeyView> {
    if (!(await this.enc.isAvailable())) throw new EncryptionUnavailableError()
    const key = input.key.trim()
    if (await this.contains(input.providerId, key)) throw new DuplicateKeyError()

    const ciphertext = await this.enc.encrypt(key)
    const id = this.newId()
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO api_keys (id, provider_id, label, ciphertext, masked, status, enabled, created_at, last_ok_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(id, input.providerId, input.label.trim(), ciphertext, maskKey(key), input.status, now, input.status === 'valid' ? now : null)
    return this.get(id)!
  }

  /** True if this exact key is already stored for the provider (ciphertexts are salted, so decrypt to compare). */
  async contains(providerId: string, key: string): Promise<boolean> {
    const rows = this.db
      .prepare<[string], { id: string }>('SELECT id FROM api_keys WHERE provider_id = ?')
      .all(providerId)
    for (const { id } of rows) {
      try {
        if ((await this.reveal(id)) === key) return true
      } catch {
        /* undecryptable row (e.g. copied from another Windows account) – not a match */
      }
    }
    return false
  }

  get(id: string): KeyView | undefined {
    const row = this.db.prepare<[string], KeyRow>(`SELECT ${VIEW_COLUMNS} FROM api_keys WHERE id = ?`).get(id)
    return row && toView(row)
  }

  list(providerId?: string): KeyView[] {
    const rows = providerId
      ? this.db
          .prepare<[string], KeyRow>(`SELECT ${VIEW_COLUMNS} FROM api_keys WHERE provider_id = ? ORDER BY created_at`)
          .all(providerId)
      : this.db.prepare<[], KeyRow>(`SELECT ${VIEW_COLUMNS} FROM api_keys ORDER BY created_at`).all()
    return rows.map(toView)
  }

  /** Decrypts a key for an outgoing provider call. Main process only; never send the result over IPC. */
  async reveal(id: string): Promise<string> {
    const row = this.db
      .prepare<[string], { ciphertext: Buffer }>('SELECT ciphertext FROM api_keys WHERE id = ?')
      .get(id)
    if (!row) throw new Error(`Unknown key ${id}`)
    const { result, shouldReEncrypt } = await this.enc.decrypt(row.ciphertext)
    if (shouldReEncrypt) {
      this.db.prepare('UPDATE api_keys SET ciphertext = ? WHERE id = ?').run(await this.enc.encrypt(result), id)
    }
    return result
  }

  setStatus(id: string, status: KeyStatus): void {
    const okAt = status === 'valid' ? this.now() : null
    this.db
      .prepare('UPDATE api_keys SET status = ?, last_ok_at = COALESCE(?, last_ok_at) WHERE id = ?')
      .run(status, okAt, id)
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0
  }
}
