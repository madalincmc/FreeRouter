import type { FreeRouterApi } from '../shared/ipc'

declare global {
  interface Window {
    freerouter: FreeRouterApi
  }
}

export {}
