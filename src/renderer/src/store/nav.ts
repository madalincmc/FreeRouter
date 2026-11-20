import { create } from 'zustand'

export type Screen = 'chat' | 'models' | 'providers' | 'gateway' | 'settings'

interface NavState {
  screen: Screen
  go(screen: Screen): void
}

export const useNav = create<NavState>((set) => ({
  screen: 'chat',
  go: (screen) => set({ screen })
}))
