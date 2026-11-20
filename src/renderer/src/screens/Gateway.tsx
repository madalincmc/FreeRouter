import { useCallback, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, RefreshCw } from 'lucide-react'
import type { GatewayRequestView, GatewayStatus } from '@shared/ipc'
import { CopyButton } from '../chat/Markdown'
import { Badge, Button, Card, Dot, Page, TextInput, Toggle } from '../components/ui'
import { invoke, useIpcEvent, useIpcMutation, useIpcQuery } from '../lib/ipc'

const TOOLS = ['Cline', 'Roo Code', 'Continue', 'Aider', 'Env vars'] as const
type Tool = (typeof TOOLS)[number]

function snippet(tool: Tool, baseUrl: string, token: string): { lang: string; text: string; note: string } {
  switch (tool) {
    case 'Cline':
    case 'Roo Code':
      return {
        lang: 'settings',
        note: `${tool} → Settings → API Provider: “OpenAI Compatible”.`,
        text: `Base URL:  ${baseUrl}\nAPI Key:   ${token}\nModel ID:  auto:coding`
      }
    case 'Continue':
      return {
        lang: 'yaml',
        note: 'Add to ~/.continue/config.yaml under models:',
        text: `models:\n  - name: FreeRouter (auto:coding)\n    provider: openai\n    model: auto:coding\n    apiBase: ${baseUrl}\n    apiKey: ${token}\n    roles: [chat, edit, apply]`
      }
    case 'Aider':
      return {
        lang: 'shell',
        note: 'Aider talks to OpenAI-compatible servers via the openai/ prefix.',
        text: `aider --openai-api-base ${baseUrl} --openai-api-key ${token} --model openai/auto:coding`
      }
    case 'Env vars':
      return {
        lang: 'powershell',
        note: 'For OpenAI SDKs and scripts (PowerShell; use export on bash).',
        text: `$env:OPENAI_BASE_URL = "${baseUrl}"\n$env:OPENAI_API_KEY = "${token}"`
      }
  }
}

const STATUS_TONE = (s: string): 'ok' | 'warn' | 'err' | 'neutral' =>
  s === 'ok' ? 'ok' : s === 'cancelled' ? 'neutral' : s === 'mid_stream_error' ? 'warn' : 'err'

export function GatewayScreen() {
  const qc = useQueryClient()
  const { data: status } = useIpcQuery('gateway:getStatus')
  const { data: token = '' } = useIpcQuery('gateway:getToken')
  const { data: requests = [] } = useQuery({ queryKey: ['gateway:recentRequests'], queryFn: () => invoke('gateway:recentRequests', 50) })
  const setEnabled = useIpcMutation('gateway:setEnabled', 'gateway:getStatus')
  const setPort = useIpcMutation('gateway:setPort', 'gateway:getStatus')
  const regenerate = useMutation({
    mutationFn: () => invoke('gateway:regenerateToken'),
    onSuccess: (t) => {
      qc.setQueryData(['gateway:getToken'], t)
      setConfirmRegen(false)
    }
  })
  const [reveal, setReveal] = useState(false)
  const [confirmRegen, setConfirmRegen] = useState(false)
  const [tool, setTool] = useState<Tool>('Cline')
  const [portDraft, setPortDraft] = useState<string | null>(null)

  const onStatus = useCallback((s: GatewayStatus) => qc.setQueryData(['gateway:getStatus'], s), [qc])
  useIpcEvent('gateway:statusChanged', onStatus)
  const onRequest = useCallback(
    (r: GatewayRequestView) => qc.setQueryData<GatewayRequestView[]>(['gateway:recentRequests'], (old = []) => [r, ...old].slice(0, 50)),
    [qc]
  )
  useIpcEvent('gateway:request', onRequest)

  const baseUrl = status?.baseUrl ?? 'http://127.0.0.1:4141/v1'
  const masked = token ? `${token.slice(0, 13)}${'•'.repeat(12)}${token.slice(-4)}` : '…'
  const s = snippet(tool, baseUrl, reveal ? token : masked)
  const portValue = portDraft ?? String(status?.port ?? 4141)
  const portNum = Number(portValue)
  const portValid = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535

  return (
    <Page title="Gateway" subtitle="Local OpenAI-compatible endpoint for Cline, Continue, Aider and any OpenAI SDK.">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <Card>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Dot tone={status?.running ? 'ok' : status?.error ? 'err' : 'neutral'} />
              <div>
                <div className="text-sm font-medium">
                  {status?.running ? 'Running' : status?.error ? 'Not running' : status?.enabled ? 'Starting…' : 'Off'}
                </div>
                <div className="text-xs text-muted">{status?.error ?? 'Bound to 127.0.0.1 only. Requires the gateway token below.'}</div>
              </div>
            </div>
            <Toggle
              label="Enable local gateway"
              checked={status?.enabled ?? false}
              disabled={!status || setEnabled.isPending}
              onChange={(on) => setEnabled.mutate([on])}
            />
          </div>
          <div className="mt-4 grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-3 text-sm">
            <span className="text-muted">Base URL</span>
            <code className="selectable font-mono text-[13px]">{baseUrl}</code>
            <CopyButton text={baseUrl} />
            <span className="text-muted">Port</span>
            <div className="flex items-center gap-2">
              <TextInput
                inputMode="numeric"
                aria-label="Gateway port"
                value={portValue}
                onChange={(e) => setPortDraft(e.target.value)}
                className="w-24 font-mono"
              />
              {portDraft !== null && portDraft !== String(status?.port) && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!portValid || setPort.isPending}
                  onClick={() => setPort.mutate([portNum], { onSuccess: () => setPortDraft(null) })}
                >
                  Apply
                </Button>
              )}
              {!portValid && <span className="text-xs text-err">1024–65535</span>}
            </div>
            <span />
            <span className="text-muted">Token</span>
            <code className="selectable truncate font-mono text-[13px]">{reveal ? token : masked}</code>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setReveal((r) => !r)} aria-label={reveal ? 'Hide token' : 'Show token'}>
                {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
              </Button>
              <CopyButton text={token} />
              {confirmRegen ? (
                <>
                  <Button size="sm" variant="danger" onClick={() => regenerate.mutate()}>
                    Regenerate
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRegen(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirmRegen(true)} title="Tools using the old token stop working">
                  <RefreshCw size={12} /> New token
                </Button>
              )}
            </div>
          </div>
        </Card>

        <Card title="Connect a tool">
          <div className="mb-3 flex flex-wrap gap-1">
            {TOOLS.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tool === t}
                onClick={() => setTool(t)}
                className={`rounded-md px-3 py-1 text-xs font-medium ${tool === t ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <p className="mb-2 text-xs text-muted">{s.note}</p>
          <div className="overflow-hidden rounded-md border border-border bg-bg">
            <div className="flex items-center justify-between border-b border-border bg-panel-2/60 px-3 py-1">
              <span className="font-mono text-[11px] text-muted">{s.lang}</span>
              <CopyButton text={snippet(tool, baseUrl, token).text} />
            </div>
            <pre className="selectable overflow-x-auto p-3 font-mono text-[13px] leading-relaxed">{s.text}</pre>
          </div>
          <p className="mt-2 text-xs text-muted">
            Models: <code>auto</code>, <code>auto:coding</code>, <code>auto:fast</code>, <code>auto:reasoning</code>, <code>auto:long</code>,{' '}
            <code>chain:&lt;name&gt;</code> or any <code>&lt;provider&gt;/&lt;model&gt;</code> from the Models screen. Claude Code isn’t supported (it
            needs the Anthropic API).
          </p>
        </Card>

        <Card title="Live requests" className="overflow-hidden">
          {requests.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted">No gateway requests yet.</p>
          ) : (
            <div className="-mx-5 -mb-5 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-y border-border bg-panel-2/50 text-left text-muted">
                    <th className="py-1.5 pl-5 font-medium">Time</th>
                    <th className="py-1.5 font-medium">Client</th>
                    <th className="py-1.5 font-medium">Asked</th>
                    <th className="py-1.5 font-medium">Used</th>
                    <th className="py-1.5 font-medium">Status</th>
                    <th className="py-1.5 text-right font-medium">Latency</th>
                    <th className="py-1.5 pr-5 text-right font-medium">Tries</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0" title={r.error ?? undefined}>
                      <td className="py-1.5 pl-5 font-mono whitespace-nowrap text-muted">{new Date(r.ts).toLocaleTimeString()}</td>
                      <td className="max-w-40 truncate py-1.5 pr-2" title={r.client ?? ''}>
                        {r.client?.split(/[\s(]/)[0] ?? '—'}
                      </td>
                      <td className="py-1.5 pr-2 font-mono">{r.requestedModel}</td>
                      <td className="max-w-56 truncate py-1.5 pr-2 font-mono" title={r.chosenModel ?? ''}>
                        {r.chosenModel ?? '—'}
                      </td>
                      <td className="py-1.5 pr-2">
                        <Badge tone={STATUS_TONE(r.status)}>{r.status.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td className="py-1.5 pr-2 text-right font-mono">{r.latencyMs !== null ? `${(r.latencyMs / 1000).toFixed(1)} s` : '—'}</td>
                      <td className={`py-1.5 pr-5 text-right font-mono ${r.attempts > 1 ? 'text-warn' : ''}`}>{r.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  )
}
