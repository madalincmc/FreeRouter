/**
 * The typed IPC contract between renderer and main (PRD §7: narrow, typed, no keys).
 * Add a channel here first; main and preload are type-checked against this map.
 */

export interface AppInfo {
  name: string
  version: string
  electron: string
  platform: string
  dataDir: string
  schemaVersion: number
  encryptionAvailable: boolean
}

export interface GatewayStatus {
  enabled: boolean
  port: number
  running: boolean // false until M5 implements the gateway
}

export type ThemePreference = 'dark' | 'light' | 'system'

// ---- Providers & keys ----------------------------------------------------

export interface Limits {
  rpm?: number
  rpd?: number
  tpm?: number
  tpd?: number
}

export type LimitScope = 'account' | 'organization' | 'project' | 'key'

export type KeyStatus = 'valid' | 'invalid' | 'untested'

/** A key as the renderer may see it: masked, never plaintext or ciphertext. */
export interface KeyView {
  id: string
  providerId: string
  label: string
  masked: string
  status: KeyStatus
  enabled: boolean
  createdAt: number
  lastOkAt: number | null
}

export interface KeyTestResult {
  outcome: 'valid' | 'invalid' | 'error'
  httpStatus?: number
  message: string
  latencyMs: number
}

export type AddKeyResult =
  | { saved: true; key: KeyView; test: KeyTestResult }
  | { saved: false; reason: 'invalid' | 'duplicate'; test?: KeyTestResult; message: string }

export interface AddKeyInput {
  providerId: string
  label: string
  key: string
}

export interface ProviderView {
  id: string
  name: string
  baseUrl: string
  keyUrl: string
  docsUrl: string
  keyPrefix?: string
  enabled: boolean
  mayTrainOnData: boolean
  limitScope: LimitScope
  keyRotation: boolean
  notes: string
  defaultLimits: Limits
  limitOverrides: Limits
  keys: KeyView[]
}

// ---- Channels ------------------------------------------------------------

export interface IpcContract {
  'app:getInfo': { args: []; result: AppInfo }
  'gateway:getStatus': { args: []; result: GatewayStatus }
  'gateway:setEnabled': { args: [enabled: boolean]; result: GatewayStatus }
  'settings:getTheme': { args: []; result: ThemePreference }
  'settings:setTheme': { args: [theme: ThemePreference]; result: ThemePreference }
  'providers:list': { args: []; result: ProviderView[] }
  'providers:setEnabled': { args: [providerId: string, enabled: boolean]; result: ProviderView[] }
  'providers:setLimitOverrides': { args: [providerId: string, overrides: Limits]; result: ProviderView[] }
  /** The only channel that carries a plaintext key – renderer → main, once. */
  'keys:add': { args: [input: AddKeyInput]; result: AddKeyResult }
  'keys:test': { args: [keyId: string]; result: KeyTestResult }
  'keys:setEnabled': { args: [keyId: string, enabled: boolean]; result: ProviderView[] }
  'keys:delete': { args: [keyId: string]; result: ProviderView[] }
}

export type IpcChannel = keyof IpcContract

/** Events pushed from main to renderer. */
export interface IpcEvents {
  'gateway:statusChanged': GatewayStatus
}

export type IpcEvent = keyof IpcEvents

/** Shape exposed on `window.freerouter` by the preload script. */
export interface FreeRouterApi {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcContract[C]['args']): Promise<IpcContract[C]['result']>
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

export const IPC_CHANNELS: readonly IpcChannel[] = [
  'app:getInfo',
  'gateway:getStatus',
  'gateway:setEnabled',
  'settings:getTheme',
  'settings:setTheme',
  'providers:list',
  'providers:setEnabled',
  'providers:setLimitOverrides',
  'keys:add',
  'keys:test',
  'keys:setEnabled',
  'keys:delete'
] as const

export const IPC_EVENTS: readonly IpcEvent[] = ['gateway:statusChanged'] as const
