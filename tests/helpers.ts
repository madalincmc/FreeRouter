import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrate } from '@core/db/migrate'
import type { Encryptor } from '@core/keys/vault'
import type { FetchLike } from '@core/keys/validate'

/** Stand-in for safeStorage: real AES-256-GCM with a per-instance random key. */
export function fakeEncryptor(available = true): Encryptor & { encryptCalls: number; rotate: boolean } {
  const key = randomBytes(32)
  const enc = {
    encryptCalls: 0,
    /** When true, decrypt reports shouldReEncrypt like safeStorage does after a key rotation. */
    rotate: false,
    isAvailable: async () => available,
    async encrypt(plaintext: string): Promise<Buffer> {
      enc.encryptCalls++
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), body])
    },
    async decrypt(ciphertext: Buffer) {
      const d = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12))
      d.setAuthTag(ciphertext.subarray(12, 28))
      const result = Buffer.concat([d.update(ciphertext.subarray(28)), d.final()]).toString('utf8')
      return { result, shouldReEncrypt: enc.rotate }
    }
  }
  return enc
}

export function memoryDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

export interface FakeResponse {
  status: number
  body?: unknown
}

/** A scripted fetch: maps URL → response (or thrown error), and records calls. */
export function fakeFetch(
  routes: Record<string, FakeResponse | Error | ((headers: Record<string, string>) => FakeResponse)>
): FetchLike & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fn = (async (url, init) => {
    calls.push({ url, headers: init.headers })
    const route = routes[url]
    if (!route) throw new Error(`fakeFetch: no route for ${url}`)
    if (route instanceof Error) throw route
    const r = typeof route === 'function' ? route(init.headers) : route
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => text }
  }) as FetchLike & { calls: typeof calls }
  fn.calls = calls
  return fn
}
