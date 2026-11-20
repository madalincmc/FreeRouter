import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, IPC_EVENTS, type FreeRouterApi } from '@shared/ipc'

// Only allow-listed channels can be reached from the renderer.
const channels = new Set<string>(IPC_CHANNELS)
const events = new Set<string>(IPC_EVENTS)

const api: FreeRouterApi = {
  invoke(channel, ...args) {
    if (!channels.has(channel)) return Promise.reject(new Error(`Unknown IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(event, listener) {
    if (!events.has(event)) throw new Error(`Unknown IPC event: ${event}`)
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload as never)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  }
}

contextBridge.exposeInMainWorld('freerouter', api)
