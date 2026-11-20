import type { ThemePreference } from '@shared/ipc'
import { Card, ComingIn, Page, Row } from '../components/ui'
import { useIpcMutation, useIpcQuery } from '../lib/ipc'

const THEMES: ThemePreference[] = ['dark', 'light', 'system']

export function SettingsScreen() {
  const { data: info } = useIpcQuery('app:getInfo')
  const { data: theme } = useIpcQuery('settings:getTheme')
  const setTheme = useIpcMutation('settings:setTheme', 'settings:getTheme')

  return (
    <Page title="Settings">
      <div className="grid gap-4">
        <Card title="Appearance">
          <div className="inline-flex rounded-md border border-border bg-panel-2 p-0.5" role="radiogroup">
            {THEMES.map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                onClick={() => setTheme.mutate([t])}
                className={`rounded px-3 py-1 text-sm capitalize ${
                  theme === t ? 'bg-panel font-medium shadow-sm' : 'text-muted hover:text-fg'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </Card>
        <Card title="About">
          {info ? (
            <>
              <Row label="Version">{info.version}</Row>
              <Row label="Electron">{info.electron}</Row>
              <Row label="Platform">{info.platform}</Row>
              <Row label="Data folder">{info.dataDir}</Row>
              <Row label="Database schema">v{info.schemaVersion}</Row>
              <Row label="Key encryption">{info.encryptionAvailable ? 'DPAPI (available)' : 'unavailable'}</Row>
            </>
          ) : (
            <p className="text-sm text-muted">Loading…</p>
          )}
        </Card>
        <ComingIn milestone="M6 – Polish">
          Routing weights, fallback chains, timeouts, stickiness, log retention, launch at login and start minimised
          to tray.
        </ComingIn>
      </div>
    </Page>
  )
}
