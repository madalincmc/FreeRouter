import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '@core/db/migrate'
import { DuplicateKeyError, EncryptionUnavailableError, KeyVault } from '@core/keys/vault'
import { bundledCatalog } from '@core/providers/catalog'
import { ProviderStore } from '@core/providers/store'
import { fakeEncryptor, memoryDb } from '../helpers'

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdefa91f'

function setup(available = true) {
  const db = memoryDb()
  new ProviderStore(db, bundledCatalog).seed()
  const enc = fakeEncryptor(available)
  return { db, enc, vault: new KeyVault(db, enc, { now: () => 1_000 }) }
}

const ciphertextOf = (db: Database.Database, id: string): Buffer =>
  (db.prepare('SELECT ciphertext FROM api_keys WHERE id = ?').get(id) as { ciphertext: Buffer }).ciphertext

describe('KeyVault', () => {
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  it('stores a key encrypted and returns only a masked view', async () => {
    const { vault } = setup()
    const view = await vault.add({ providerId: 'openrouter', label: ' main ', key: KEY, status: 'valid' })
    expect(view).toEqual({
      id: view.id,
      providerId: 'openrouter',
      label: 'main',
      masked: 'sk-or-…a91f',
      status: 'valid',
      enabled: true,
      createdAt: 1_000,
      lastOkAt: 1_000
    })
    expect(JSON.stringify(vault.list())).not.toContain(KEY.slice(10))
    expect(await vault.reveal(view.id)).toBe(KEY)
  })

  it('never writes the plaintext key to the database files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-vault-'))
    dirs.push(dir)
    const db = new Database(join(dir, 'test.db'))
    db.pragma('journal_mode = WAL')
    migrate(db)
    new ProviderStore(db, bundledCatalog).seed()
    await new KeyVault(db, fakeEncryptor()).add({ providerId: 'openrouter', label: 'x', key: KEY, status: 'valid' })
    db.close()

    const secretPart = Buffer.from(KEY.slice(12))
    const files = readdirSync(dir).map((f) => ({ f, bytes: readFileSync(join(dir, f)) }))
    for (const { f, bytes } of files) expect(bytes.includes(secretPart), `${f} contains the key`).toBe(false)
    // Sanity check that the scan sees row data at all: the masked value is stored in clear.
    expect(files.some(({ bytes }) => bytes.includes(Buffer.from('sk-or-…a91f')))).toBe(true)
  })

  it('refuses to store anything when encryption is unavailable', async () => {
    const { vault, db } = setup(false)
    await expect(vault.add({ providerId: 'groq', label: '', key: 'gsk_abcdefghijklmnop', status: 'valid' })).rejects.toThrow(
      EncryptionUnavailableError
    )
    expect(db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 0 })
  })

  it('rejects duplicates per provider but allows several distinct keys', async () => {
    const { vault } = setup()
    await vault.add({ providerId: 'groq', label: 'a', key: 'gsk_aaaaaaaaaaaaaaaa1111', status: 'valid' })
    await vault.add({ providerId: 'groq', label: 'b', key: 'gsk_bbbbbbbbbbbbbbbb2222', status: 'valid' })
    await expect(
      vault.add({ providerId: 'groq', label: 'c', key: ' gsk_aaaaaaaaaaaaaaaa1111 ', status: 'valid' })
    ).rejects.toThrow(DuplicateKeyError)
    expect(vault.list('groq').map((k) => k.label)).toEqual(['a', 'b'])
  })

  it('re-encrypts transparently when the OS key was rotated', async () => {
    const { vault, enc, db } = setup()
    const { id } = await vault.add({ providerId: 'groq', label: '', key: 'gsk_aaaaaaaaaaaaaaaa1111', status: 'valid' })
    const before = ciphertextOf(db, id)
    enc.rotate = true
    expect(await vault.reveal(id)).toBe('gsk_aaaaaaaaaaaaaaaa1111')
    expect(ciphertextOf(db, id).equals(before)).toBe(false)
    enc.rotate = false
    expect(await vault.reveal(id)).toBe('gsk_aaaaaaaaaaaaaaaa1111')
  })

  it('updates status, enabled flag and deletes', async () => {
    const { vault } = setup()
    const { id } = await vault.add({ providerId: 'groq', label: '', key: 'gsk_aaaaaaaaaaaaaaaa1111', status: 'untested' })
    expect(vault.get(id)?.lastOkAt).toBeNull()
    vault.setStatus(id, 'valid')
    expect(vault.get(id)).toMatchObject({ status: 'valid', lastOkAt: 1_000 })
    vault.setStatus(id, 'invalid')
    expect(vault.get(id)).toMatchObject({ status: 'invalid', lastOkAt: 1_000 })
    vault.setEnabled(id, false)
    expect(vault.get(id)?.enabled).toBe(false)
    expect(vault.delete(id)).toBe(true)
    expect(vault.get(id)).toBeUndefined()
  })
})
