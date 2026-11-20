import type { AddKeyInput, AddKeyResult, KeyTestResult } from '@shared/ipc'
import type { ProviderStore } from '../providers/store'
import { testKey, type FetchLike } from './validate'
import { DuplicateKeyError, type KeyVault } from './vault'

export interface KeyServiceOptions {
  fetch: FetchLike
  timeoutMs?: number
}

/** Add/test flows for provider keys. Pure core logic; the main process supplies fetch and the vault. */
export class KeyService {
  constructor(
    private readonly vault: KeyVault,
    private readonly providers: ProviderStore,
    private readonly opts: KeyServiceOptions
  ) {}

  /**
   * Validates the key with a cheap test call before saving (PRD §7).
   * - rejected by the provider → not saved
   * - accepted → saved as `valid`
   * - provider unreachable → saved as `untested` so the user can add keys offline
   */
  async add(input: AddKeyInput): Promise<AddKeyResult> {
    const profile = this.providers.profile(input.providerId)
    if (!profile) throw new Error(`Unknown provider: ${input.providerId}`)
    const key = input.key.trim()

    if (await this.vault.contains(profile.id, key)) {
      return { saved: false, reason: 'duplicate', message: new DuplicateKeyError().message }
    }

    const test = await testKey(profile, key, this.opts)
    if (test.outcome === 'invalid') {
      return { saved: false, reason: 'invalid', test, message: `${profile.name} rejected this key: ${test.message}` }
    }

    const saved = await this.vault.add({
      providerId: profile.id,
      label: input.label,
      key,
      status: test.outcome === 'valid' ? 'valid' : 'untested'
    })
    return { saved: true, key: saved, test }
  }

  /** Re-tests a stored key and records the outcome. Network errors leave the status unchanged. */
  async test(keyId: string): Promise<KeyTestResult> {
    const view = this.vault.get(keyId)
    if (!view) throw new Error(`Unknown key ${keyId}`)
    const profile = this.providers.profile(view.providerId)
    if (!profile) throw new Error(`Unknown provider: ${view.providerId}`)

    const result = await testKey(profile, await this.vault.reveal(keyId), this.opts)
    if (result.outcome !== 'error') this.vault.setStatus(keyId, result.outcome)
    return result
  }
}
