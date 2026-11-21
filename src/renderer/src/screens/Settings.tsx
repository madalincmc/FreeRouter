import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, X } from 'lucide-react'
import type { AppSettings, ChainView, ColorScheme, ModelOptions, RoutingSettings, ThemePreference, UpdateStatus } from '@shared/ipc'
import { Badge, Button, Card, Page, Row, TextInput, Toggle } from '../components/ui'
import { invoke, useIpcEvent, useIpcMutation, useIpcQuery } from '../lib/ipc'

const THEMES: ThemePreference[] = ['dark', 'light', 'system']

/** Swatches preview each scheme's accents (light, dark) and dark background; keep in sync with index.css. */
const SCHEMES: { id: ColorScheme; label: string; swatches: string[] }[] = [
  { id: 'indigo', label: 'Indigo', swatches: ['#5b5bd6', '#7c7cf0', '#12151c'] },
  { id: 'ocean', label: 'Ocean', swatches: ['#0e7490', '#22d3ee', '#0b1c21'] }
]

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border py-3 last:border-0">
      <div>
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function NumberInput({ value, onChange, min, max, step = 1, suffix }: { value: number; onChange: (n: number) => void; min: number; max: number; step?: number; suffix?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <TextInput
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-20 text-right font-mono"
      />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </span>
  )
}

export function SettingsScreen() {
  const qc = useQueryClient()
  const { data: info } = useIpcQuery('app:getInfo')
  const { data: theme } = useIpcQuery('settings:getTheme')
  const { data: settings } = useIpcQuery('settings:get')
  const setTheme = useIpcMutation('settings:setTheme', 'settings:getTheme')
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof window.freerouter.invoke<'settings:update'>>[1]) => invoke('settings:update', patch),
    onSuccess: (s) => qc.setQueryData(['settings:get'], s)
  })

  return (
    <Page title="Settings">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {settings && <RoutingCard routing={settings.routing} />}
        <ChainsCard />

        {settings && (
          <Card title="Privacy & data">
            <Field label="Private mode (everywhere)" hint="Exclude providers that may log or train on prompts, for chat and the gateway.">
              <Toggle label="Private mode" checked={settings.privateMode} onChange={(v) => update.mutate({ privateMode: v })} />
            </Field>
            <Field label="Keep request log for" hint="Metadata only (models, timings, status). Prompts and replies are never logged.">
              <NumberInput value={settings.logRetentionDays} min={1} max={365} suffix="days" onChange={(n) => n >= 1 && n <= 365 && update.mutate({ logRetentionDays: n })} />
            </Field>
            <OriginsField settings={settings} onSave={(o) => update.mutate({ gatewayAllowedOrigins: o })} />
          </Card>
        )}

        {settings && (
          <Card title="Startup">
            <Field label="Launch at login" hint="Starts hidden in the tray so the gateway is ready for your tools.">
              <Toggle label="Launch at login" checked={settings.launchAtLogin} onChange={(v) => update.mutate({ launchAtLogin: v })} />
            </Field>
            <Field label="Start minimised to tray" hint="Open the window from the tray icon when you need it.">
              <Toggle label="Start minimised" checked={settings.startMinimized} onChange={(v) => update.mutate({ startMinimized: v })} />
            </Field>
          </Card>
        )}

        {settings && <UpdatesCard autoUpdate={settings.autoUpdate} onToggle={(v) => update.mutate({ autoUpdate: v })} />}

        <Card title="Appearance">
          <Field label="Theme" hint="System follows Windows’ light or dark setting.">
            <div className="inline-flex rounded-md border border-border bg-panel-2 p-0.5" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={theme === t}
                  onClick={() => setTheme.mutate([t])}
                  className={`rounded px-3 py-1 text-sm capitalize ${theme === t ? 'bg-panel font-medium shadow-sm' : 'text-muted hover:text-fg'}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </Field>
          {settings && (
            <Field label="Colour scheme" hint="Accent and background colours. Works with every theme.">
              <div className="flex gap-2" role="radiogroup" aria-label="Colour scheme">
                {SCHEMES.map((s) => {
                  const active = settings.colorScheme === s.id
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => update.mutate({ colorScheme: s.id })}
                      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                        active ? 'border-accent bg-panel-2 font-medium' : 'border-border text-muted hover:text-fg'
                      }`}
                    >
                      <span className="flex -space-x-1" aria-hidden>
                        {s.swatches.map((c) => (
                          <span key={c} className="h-3.5 w-3.5 rounded-full border border-border" style={{ background: c }} />
                        ))}
                      </span>
                      {s.label}
                    </button>
                  )
                })}
              </div>
            </Field>
          )}
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
      </div>
    </Page>
  )
}

/** The UI edits weights in 0–100 units; the core normalises them to shares on save. */
const toUi = (r: RoutingSettings): RoutingSettings => ({
  ...r,
  weights: {
    quality: Math.round(r.weights.quality * 100),
    reliability: Math.round(r.weights.reliability * 100),
    speed: Math.round(r.weights.speed * 100),
    headroom: Math.round(r.weights.headroom * 100)
  }
})

function RoutingCard({ routing }: { routing: RoutingSettings }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState(() => toUi(routing))
  useEffect(() => setDraft(toUi(routing)), [routing])
  const save = useMutation({
    mutationFn: () => invoke('settings:update', { routing: draft }),
    onSuccess: (s: AppSettings) => qc.setQueryData(['settings:get'], s)
  })
  const reset = useMutation({ mutationFn: () => invoke('settings:resetRouting'), onSuccess: (s) => qc.setQueryData(['settings:get'], s) })

  const w = draft.weights
  const sum = w.quality + w.reliability + w.speed + w.headroom
  const pct = (n: number) => (sum > 0 ? Math.round((n / sum) * 100) : 0)
  const dirty = JSON.stringify(draft) !== JSON.stringify(toUi(routing))
  const valid =
    sum > 0 &&
    draft.topN >= 1 &&
    draft.topN <= 10 &&
    draft.maxPerProvider >= 1 &&
    draft.ttftTimeoutMs >= 2000 &&
    draft.totalTimeoutMs >= 10_000 &&
    draft.minToolsQuality >= 0 &&
    draft.minToolsQuality <= 100
  const setW = (k: keyof RoutingSettings['weights'], v: number) => setDraft((d) => ({ ...d, weights: { ...d.weights, [k]: v } }))

  return (
    <Card title="Routing">
      <div className="mb-2 text-xs text-muted">
        Score = quality · reliability · speed · headroom, weighted as below (relative values; saved as shares of 100%).
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-2">
        {(['quality', 'reliability', 'speed', 'headroom'] as const).map((k) => (
          <label key={k} className="flex items-center gap-3 text-sm">
            <span className="w-20 capitalize">{k}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={w[k]}
              onChange={(e) => setW(k, Number(e.target.value))}
              className="min-w-0 flex-1 accent-[var(--accent)]"
              aria-label={`${k} weight`}
            />
            <span className="w-10 text-right font-mono text-xs">{pct(w[k])}%</span>
          </label>
        ))}
      </div>
      <div className="mt-3">
        <Field label="Candidates per request" hint="Top N models tried in order (PRD default 5).">
          <NumberInput value={draft.topN} min={1} max={10} onChange={(n) => setDraft((d) => ({ ...d, topN: n }))} />
        </Field>
        <Field label="Max candidates per provider" hint="So one provider outage can’t empty the list.">
          <NumberInput value={draft.maxPerProvider} min={1} max={10} onChange={(n) => setDraft((d) => ({ ...d, maxPerProvider: n }))} />
        </Field>
        <Field label="First-token timeout" hint="Give up on a model that hasn’t started answering and try the next.">
          <NumberInput value={draft.ttftTimeoutMs / 1000} min={2} max={120} suffix="s" onChange={(n) => setDraft((d) => ({ ...d, ttftTimeoutMs: Math.round(n * 1000) }))} />
        </Field>
        <Field label="Overall timeout" hint="Maximum time for one answer.">
          <NumberInput value={draft.totalTimeoutMs / 1000} min={10} max={900} suffix="s" onChange={(n) => setDraft((d) => ({ ...d, totalTimeoutMs: Math.round(n * 1000) }))} />
        </Field>
        <Field label="Minimum tool-calling quality" hint="Requests with tools only go to models scoring at least this (0–100).">
          <NumberInput value={draft.minToolsQuality} min={0} max={100} onChange={(n) => setDraft((d) => ({ ...d, minToolsQuality: n }))} />
        </Field>
        <Field label="Fall back when a model is pinned" hint="If the pinned model fails, try the automatic candidates.">
          <Toggle label="Fallback when pinned" checked={draft.allowFallbackWhenPinned} onChange={(v) => setDraft((d) => ({ ...d, allowFallbackWhenPinned: v }))} />
        </Field>
        <Field label="Stickiness" hint="Keep a conversation or coding session on the model that last worked, until it fails.">
          <Toggle label="Stickiness" checked={draft.stickiness} onChange={(v) => setDraft((d) => ({ ...d, stickiness: v }))} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" disabled={!dirty || !valid || save.isPending} onClick={() => save.mutate()}>
          Save routing
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(toUi(routing))}>
            Discard
          </Button>
        )}
        <Button variant="ghost" className="ml-auto" onClick={() => reset.mutate()}>
          Reset to defaults
        </Button>
        {!valid && <span className="text-xs text-err">Check the values.</span>}
      </div>
    </Card>
  )
}

function ChainsCard() {
  const qc = useQueryClient()
  const { data: chains = [] } = useIpcQuery('chains:list')
  const { data: options } = useIpcQuery('chat:modelOptions')
  const [newName, setNewName] = useState('')
  const save = useMutation({
    mutationFn: (c: ChainView) => invoke('chains:save', c.name, c.modelIds),
    onSuccess: (list) => {
      qc.setQueryData(['chains:list'], list)
      void qc.invalidateQueries({ queryKey: ['chat:modelOptions'] })
    }
  })
  const remove = useMutation({
    mutationFn: (name: string) => invoke('chains:delete', name),
    onSuccess: (list) => {
      qc.setQueryData(['chains:list'], list)
      void qc.invalidateQueries({ queryKey: ['chat:modelOptions'] })
    }
  })
  const nameOk = /^[\w.-]{1,40}$/.test(newName) && !chains.some((c) => c.name === newName)

  return (
    <Card title="Fallback chains">
      <p className="mb-3 text-xs text-muted">
        An ordered list of models tried top to bottom. Use it as <code>chain:&lt;name&gt;</code> in the chat picker or from any tool. Models that are gone or
        unavailable are skipped.
      </p>
      <div className="space-y-3">
        {chains.map((c) => (
          <ChainEditor key={c.name} chain={c} options={options} onChange={(ids) => save.mutate({ name: c.name, modelIds: ids })} onDelete={() => remove.mutate(c.name)} />
        ))}
      </div>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!nameOk) return
          save.mutate({ name: newName, modelIds: [] })
          setNewName('')
        }}
      >
        <TextInput placeholder="new-chain-name" aria-label="New chain name" value={newName} onChange={(e) => setNewName(e.target.value)} className="w-56 font-mono" />
        <Button type="submit" disabled={!nameOk}>
          <Plus size={13} /> New chain
        </Button>
      </form>
    </Card>
  )
}

function ChainEditor({
  chain,
  options,
  onChange,
  onDelete
}: {
  chain: ChainView
  options: ModelOptions | undefined
  onChange: (ids: string[]) => void
  onDelete: () => void
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const ids = chain.modelIds
  const available = new Set(options?.models.map((m) => m.id))
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length || from === to) return
    const next = [...ids]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item!)
    onChange(next)
  }

  return (
    <div className="rounded-md border border-border bg-bg/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <code className="text-sm font-medium">chain:{chain.name}</code>
        <Button size="sm" variant="ghost" onClick={onDelete} aria-label={`Delete chain ${chain.name}`}>
          <Trash2 size={13} />
        </Button>
      </div>
      <ol className="space-y-1">
        {ids.map((id, i) => (
          <li
            key={id}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIndex !== null) move(dragIndex, i)
              setDragIndex(null)
            }}
            className={`flex items-center gap-2 rounded border border-border bg-panel px-2 py-1 text-sm ${dragIndex === i ? 'opacity-50' : ''}`}
          >
            <GripVertical size={14} className="cursor-grab text-muted" />
            <span className="w-5 text-right font-mono text-xs text-muted">{i + 1}</span>
            <span className="flex-1 truncate font-mono text-[13px]">{id}</span>
            {!available.has(id) && <Badge tone="warn">not routable now</Badge>}
            <Button size="sm" variant="ghost" aria-label="Move up" onClick={() => move(i, i - 1)} disabled={i === 0}>
              <ArrowUp size={12} />
            </Button>
            <Button size="sm" variant="ghost" aria-label="Move down" onClick={() => move(i, i + 1)} disabled={i === ids.length - 1}>
              <ArrowDown size={12} />
            </Button>
            <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => onChange(ids.filter((x) => x !== id))}>
              <X size={12} />
            </Button>
          </li>
        ))}
        {ids.length === 0 && <li className="text-xs text-muted">No models yet.</li>}
      </ol>
      <select
        aria-label={`Add model to ${chain.name}`}
        value=""
        onChange={(e) => e.target.value && onChange([...ids, e.target.value])}
        className="mt-2 h-8 rounded-md border border-border bg-bg px-2 text-sm"
      >
        <option value="">+ Add a model…</option>
        {options?.models
          .filter((m) => !ids.includes(m.id))
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.provider}: {m.label}
            </option>
          ))}
      </select>
    </div>
  )
}

function updateLine(s: UpdateStatus): { text: string; tone?: 'ok' | 'warn' | 'err' } {
  switch (s.state) {
    case 'disabled':
      return { text: 'Updates are only available in the installed app.' }
    case 'idle':
      return { text: 'Not checked yet.' }
    case 'checking':
      return { text: 'Checking for updates…' }
    case 'up-to-date':
      return { text: `You’re on the latest version${s.checkedAt ? ` (checked ${new Date(s.checkedAt).toLocaleTimeString()})` : ''}.`, tone: 'ok' }
    case 'downloading':
      return { text: `Downloading v${s.availableVersion}… ${s.percent ?? 0}%` }
    case 'ready':
      return { text: `v${s.availableVersion} is ready. It installs when you restart or quit FreeRouter.`, tone: 'ok' }
    case 'error':
      return { text: `Update check failed: ${s.error ?? 'unknown error'}`, tone: 'err' }
  }
}

function UpdatesCard({ autoUpdate, onToggle }: { autoUpdate: boolean; onToggle: (v: boolean) => void }) {
  const qc = useQueryClient()
  const { data: status } = useIpcQuery('updates:getStatus')
  useIpcEvent(
    'updates:status',
    useCallback((s: UpdateStatus) => qc.setQueryData(['updates:getStatus'], s), [qc])
  )
  const check = useMutation({ mutationFn: () => invoke('updates:check'), onSuccess: (s) => qc.setQueryData(['updates:getStatus'], s) })
  const install = useMutation({ mutationFn: () => invoke('updates:install') })
  if (!status) return null
  const line = updateLine(status)
  const busy = status.state === 'checking' || status.state === 'downloading'

  return (
    <Card title="Updates">
      <Field label="Check for updates automatically" hint="Looks for new releases on GitHub every 6 hours and downloads them in the background.">
        <Toggle label="Automatic updates" checked={autoUpdate} onChange={onToggle} />
      </Field>
      <div className="flex items-center gap-3 pt-3">
        <span className={`flex-1 text-sm ${line.tone === 'err' ? 'text-err' : line.tone === 'ok' ? '' : 'text-muted'}`}>{line.text}</span>
        {status.state === 'ready' ? (
          <Button variant="primary" disabled={install.isPending} onClick={() => install.mutate()}>
            Restart & update
          </Button>
        ) : (
          <Button disabled={status.state === 'disabled' || busy || check.isPending} onClick={() => check.mutate()}>
            Check now
          </Button>
        )}
      </div>
    </Card>
  )
}

function OriginsField({ settings, onSave }: { settings: AppSettings; onSave: (o: string[]) => void }) {
  const [text, setText] = useState(settings.gatewayAllowedOrigins.join(', '))
  useEffect(() => setText(settings.gatewayAllowedOrigins.join(', ')), [settings.gatewayAllowedOrigins])
  const list = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const valid = list.every((o) => /^https?:\/\/[^\s/]+$/.test(o))
  const dirty = list.join(',') !== settings.gatewayAllowedOrigins.join(',')
  return (
    <Field label="Gateway: allowed browser origins" hint="Browser pages are blocked from the gateway unless listed here (e.g. http://localhost:3000).">
      <TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder="none" aria-label="Allowed origins" className="w-64 font-mono text-xs" />
      <Button size="sm" disabled={!dirty || !valid} onClick={() => onSave(list)}>
        Save
      </Button>
    </Field>
  )
}
