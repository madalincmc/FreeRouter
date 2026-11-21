import { useEffect } from 'react'
import { Boxes, KeyRound, MessageSquare, Network, Settings as SettingsIcon, type LucideIcon } from 'lucide-react'
import { useIpcQuery } from './lib/ipc'
import { useChatEvents } from './chat/live'
import { useNav, type Screen } from './store/nav'
import { ChatScreen } from './screens/Chat'
import { ModelsScreen } from './screens/Models'
import { ProvidersScreen } from './screens/Providers'
import { GatewayScreen } from './screens/Gateway'
import { SettingsScreen } from './screens/Settings'

const NAV: { id: Screen; label: string; icon: LucideIcon }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'providers', label: 'Providers & keys', icon: KeyRound },
  { id: 'gateway', label: 'Gateway', icon: Network },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
]

const SCREENS: Record<Screen, () => React.JSX.Element> = {
  chat: ChatScreen,
  models: ModelsScreen,
  providers: ProvidersScreen,
  gateway: GatewayScreen,
  settings: SettingsScreen
}

function useThemeClass(): void {
  const { data: theme = 'dark' } = useIpcQuery('settings:getTheme')
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])

  const { data: settings } = useIpcQuery('settings:get')
  const scheme = settings?.colorScheme ?? 'indigo'
  useEffect(() => {
    document.documentElement.dataset.scheme = scheme
  }, [scheme])
}

export function App(): React.JSX.Element {
  const { screen, go } = useNav()
  const { data: gateway } = useIpcQuery('gateway:getStatus')
  useThemeClass()
  // App-level so streams keep updating while another screen is open.
  useChatEvents()
  const Current = SCREENS[screen]

  return (
    <div className="flex h-full">
      <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-panel">
        <div className="flex items-center gap-2 px-4 py-4">
          <img src="./logo.png" alt="" className="h-7 w-7" />
          <span className="text-[15px] font-semibold tracking-tight">FreeRouter</span>
        </div>
        <ul className="flex flex-1 flex-col gap-0.5 px-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => go(id)}
                aria-current={screen === id ? 'page' : undefined}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  screen === id ? 'bg-panel-2 font-medium text-fg' : 'text-muted hover:bg-panel-2/60 hover:text-fg'
                }`}
              >
                <Icon size={16} strokeWidth={1.75} />
                {label}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted">
          <span
            className={`h-2 w-2 rounded-full ${gateway?.running ? 'bg-ok' : gateway?.enabled ? 'bg-warn' : 'bg-muted'}`}
          />
          {gateway
            ? `Gateway ${gateway.running ? 'running' : gateway.enabled ? 'not started' : 'off'} · :${gateway.port}`
            : 'Gateway…'}
        </div>
      </nav>
      <main className={`min-w-0 flex-1 ${screen === 'chat' ? 'overflow-hidden' : 'overflow-auto'}`}>
        <Current />
      </main>
    </div>
  )
}
