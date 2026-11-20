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
}

export interface GatewayStatus {
  enabled: boolean
  port: number
  running: boolean // false until M5 implements the gateway
}

export type ThemePreference = 'dark' | 'light' | 'system'

export interface IpcContract {
  'app:getInfo': { args: []; result: AppInfo }
  'gateway:getStatus': { args: []; result: GatewayStatus }
  'gateway:setEnabled': { args: [enabled: boolean]; result: GatewayStatus }
  'settings:getTheme': { args: []; result: ThemePreference }
  'settings:setTheme': { args: [theme: ThemePreference]; result: ThemePreference }
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
  'settings:setTheme'
] as const

export const IPC_EVENTS: readonly IpcEvent[] = ['gateway:statusChanged'] as const
