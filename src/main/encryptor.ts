import { safeStorage } from 'electron'
import type { Encryptor } from '@core/keys/vault'

/**
 * Electron's async safeStorage (the sync API is deprecated since Electron 45). On Windows the
 * encryption key is protected with DPAPI, bound to the current Windows user account.
 */
export const safeStorageEncryptor: Encryptor = {
  isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptStringAsync(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptStringAsync(ciphertext)
}
