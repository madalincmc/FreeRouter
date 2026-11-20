import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { GatewayStatus } from '@shared/ipc'
import { Card, ComingIn, Page, Row } from '../components/ui'
import { useIpcEvent, useIpcMutation, useIpcQuery } from '../lib/ipc'

export function GatewayScreen() {
  const qc = useQueryClient()
  const { data: status } = useIpcQuery('gateway:getStatus')
  const setEnabled = useIpcMutation('gateway:setEnabled', 'gateway:getStatus')

  // The tray can toggle the gateway too, so keep the screen in sync.
  const onStatus = useCallback((s: GatewayStatus) => qc.setQueryData(['gateway:getStatus'], s), [qc])
  useIpcEvent('gateway:statusChanged', onStatus)

  return (
    <Page title="Gateway" subtitle="Local OpenAI-compatible endpoint for Cline, Continue, Aider and other tools.">
      <div className="grid gap-4">
        <Card title="Status">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <div>Enable local gateway</div>
              <div className="text-xs text-muted">Binds to 127.0.0.1 only. Requires the gateway token.</div>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                className="peer sr-only"
                checked={status?.enabled ?? false}
                disabled={!status || setEnabled.isPending}
                onChange={(e) => setEnabled.mutate([e.target.checked])}
              />
              <span className="h-5 w-9 rounded-full bg-panel-2 ring-1 ring-border transition-colors peer-checked:bg-accent" />
              <span className="absolute left-0.5 h-4 w-4 rounded-full bg-fg transition-transform peer-checked:translate-x-4 peer-checked:bg-accent-fg" />
            </label>
          </div>
          <div className="mt-3">
            <Row label="Base URL">http://127.0.0.1:{status?.port ?? 4141}/v1</Row>
            <Row label="Server">{status?.running ? 'running' : 'not implemented yet'}</Row>
          </div>
        </Card>
        <ComingIn milestone="M5 – Gateway">
          /v1/chat/completions (streaming and tools), /v1/models, the gateway token, a live request log and
          &ldquo;Connect a tool&rdquo; snippets.
        </ComingIn>
      </div>
    </Page>
  )
}
