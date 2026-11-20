import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ExternalLink, KeyRound, Loader2, ShieldAlert, Trash2 } from 'lucide-react'
import type { AddKeyResult, KeyTestResult, KeyView, Limits, ProviderView } from '@shared/ipc'
import { Badge, Button, Card, Dot, Page, TextInput, Toggle } from '../components/ui'
import { invoke, useIpcMutation, useIpcQuery } from '../lib/ipc'
import { compactNumber, timeAgo } from '../lib/format'

const LIMIT_FIELDS: { key: keyof Limits; label: string }[] = [
  { key: 'rpm', label: 'Requests / min' },
  { key: 'rpd', label: 'Requests / day' },
  { key: 'tpm', label: 'Tokens / min' },
  { key: 'tpd', label: 'Tokens / day' }
]

const SCOPE_LABEL: Record<ProviderView['limitScope'], string> = {
  account: 'per account',
  organization: 'per organization',
  project: 'per project',
  key: 'per key'
}

export function ProvidersScreen() {
  const { data: providers, isLoading } = useIpcQuery('providers:list')
  const { data: info } = useIpcQuery('app:getInfo')
  const configured = providers?.filter((p) => p.keys.some((k) => k.enabled && k.status !== 'invalid')).length ?? 0

  return (
    <Page
      title="Providers & keys"
      subtitle="Keys are encrypted with Windows DPAPI and never leave the main process. You only ever see them masked."
    >
      {info && !info.encryptionAvailable && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-err/40 bg-err/10 px-4 py-3 text-sm text-err">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
          OS encryption is unavailable, so keys cannot be stored. FreeRouter never falls back to plaintext.
        </div>
      )}
      {providers && (
        <p className="mb-4 text-sm text-muted">
          {configured} of {providers.length} providers have a usable key.
          {configured < 3 && ' Add at least three for reliable fallback.'}
        </p>
      )}
      {isLoading && <p className="text-sm text-muted">Loading providers…</p>}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
        {providers?.map((p) => (
          <ProviderCard key={p.id} provider={p} />
        ))}
      </div>
    </Page>
  )
}

function ProviderCard({ provider: p }: { provider: ProviderView }) {
  const setEnabled = useIpcMutation('providers:setEnabled', 'providers:list')
  const [showLimits, setShowLimits] = useState(false)

  return (
    <Card className={p.enabled ? '' : 'opacity-70'}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold">{p.name}</h2>
            {p.mayTrainOnData && (
              <Badge tone="warn" title="Free-tier prompts may be logged or used for training. Private mode excludes this provider.">
                <AlertTriangle size={11} /> may train on data
              </Badge>
            )}
            {p.keys.length === 0 && <Badge>no key</Badge>}
          </div>
          <p className="selectable mt-0.5 font-mono text-xs text-muted">{p.baseUrl}</p>
        </div>
        <div className="flex items-center gap-3">
          <a href={p.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
            Get a key <ExternalLink size={12} />
          </a>
          <Toggle
            label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}
            checked={p.enabled}
            disabled={setEnabled.isPending}
            onChange={(on) => setEnabled.mutate([p.id, on])}
          />
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted">{p.notes}</p>

      <div className="mt-4 space-y-2">
        {p.keys.map((k) => (
          <KeyRow key={k.id} k={k} />
        ))}
      </div>

      <AddKeyForm provider={p} />

      <div className="mt-4 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setShowLimits((v) => !v)}
          className="text-xs text-muted hover:text-fg"
          aria-expanded={showLimits}
        >
          {showLimits ? '▾' : '▸'} Free-tier limits ({SCOPE_LABEL[p.limitScope]}): {summarizeLimits({ ...p.defaultLimits, ...p.limitOverrides })}
          {Object.keys(p.limitOverrides).length > 0 && <span className="ml-1 text-accent">· overridden</span>}
        </button>
        {showLimits && <LimitsEditor provider={p} />}
      </div>
    </Card>
  )
}

function summarizeLimits(l: Limits): string {
  const parts = LIMIT_FIELDS.filter((f) => l[f.key]).map((f) => `${compactNumber(l[f.key]!)} ${f.key.toUpperCase()}`)
  return parts.length ? parts.join(' · ') : 'unknown'
}

function statusTone(k: KeyView) {
  if (!k.enabled) return 'neutral' as const
  return k.status === 'valid' ? ('ok' as const) : k.status === 'invalid' ? ('err' as const) : ('warn' as const)
}

function KeyRow({ k }: { k: KeyView }) {
  const qc = useQueryClient()
  const setEnabled = useIpcMutation('keys:setEnabled', 'providers:list')
  const remove = useIpcMutation('keys:delete', 'providers:list')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [lastTest, setLastTest] = useState<KeyTestResult>()
  const test = useMutation({
    mutationFn: () => invoke('keys:test', k.id),
    onSuccess: (r) => {
      setLastTest(r)
      void qc.invalidateQueries({ queryKey: ['providers:list'] })
    }
  })

  return (
    <div className="rounded-md border border-border bg-bg/40 px-3 py-2">
      <div className="flex items-center gap-3">
        <Dot tone={statusTone(k)} />
        <KeyRound size={14} className="shrink-0 text-muted" />
        <span className="selectable font-mono text-[13px]">{k.masked}</span>
        {k.label && <span className="truncate text-sm text-muted">{k.label}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted">
          {k.status === 'valid' ? `valid · ok ${timeAgo(k.lastOkAt)}` : k.status}
        </span>
        <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? <Loader2 size={12} className="animate-spin" /> : null} Test
        </Button>
        <Toggle
          label={k.enabled ? 'Disable key' : 'Enable key'}
          checked={k.enabled}
          disabled={setEnabled.isPending}
          onChange={(on) => setEnabled.mutate([k.id, on])}
        />
        {confirmDelete ? (
          <span className="flex items-center gap-1">
            <Button size="sm" variant="danger" onClick={() => remove.mutate([k.id])} disabled={remove.isPending}>
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" aria-label="Delete key" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={13} />
          </Button>
        )}
      </div>
      {lastTest && <TestMessage result={lastTest} />}
    </div>
  )
}

function TestMessage({ result }: { result: KeyTestResult }) {
  const tone = result.outcome === 'valid' ? 'text-ok' : result.outcome === 'invalid' ? 'text-err' : 'text-warn'
  return (
    <p className={`selectable mt-1.5 pl-5 text-xs ${tone}`}>
      {result.message}
      {result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''} · {result.latencyMs} ms
    </p>
  )
}

function AddKeyForm({ provider: p }: { provider: ProviderView }) {
  const qc = useQueryClient()
  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [result, setResult] = useState<AddKeyResult>()
  const add = useMutation({
    mutationFn: () => invoke('keys:add', { providerId: p.id, label, key }),
    onSuccess: (r) => {
      setResult(r)
      if (r.saved) {
        setKey('') // drop the plaintext from renderer memory as soon as it's stored
        setLabel('')
        void qc.invalidateQueries({ queryKey: ['providers:list'] })
      }
    }
  })

  const trimmed = key.trim()
  const formatError =
    trimmed.length === 0 ? null : /\s/.test(trimmed) ? 'Keys cannot contain spaces' : trimmed.length < 8 ? 'Too short' : null
  const prefixHint =
    p.keyPrefix && trimmed.length >= p.keyPrefix.length && !trimmed.startsWith(p.keyPrefix)
      ? `${p.name} keys usually start with “${p.keyPrefix}”`
      : null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed || formatError) return
    setResult(undefined)
    add.mutate()
  }

  return (
    <form onSubmit={submit} className="mt-3">
      <div className="flex gap-2">
        <TextInput
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={p.keyPrefix ? `${p.keyPrefix}…` : 'API key'}
          aria-label={`${p.name} API key`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className="min-w-0 flex-1 font-mono"
        />
        <TextInput
          placeholder="Label (optional)"
          aria-label="Key label"
          maxLength={64}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-44"
        />
        <Button type="submit" variant="primary" disabled={!trimmed || !!formatError || add.isPending}>
          {add.isPending && <Loader2 size={14} className="animate-spin" />}
          {add.isPending ? 'Testing…' : 'Add & test'}
        </Button>
      </div>
      {(formatError || prefixHint) && <p className="mt-1.5 text-xs text-warn">{formatError ?? prefixHint}</p>}
      {!p.keyRotation && p.keys.length > 0 && (
        <p className="mt-1.5 text-xs text-muted">
          Limits are {SCOPE_LABEL[p.limitScope]}: extra keys from the same account don’t add capacity.
        </p>
      )}
      {add.isError && <p className="mt-1.5 text-xs text-err">{(add.error as Error).message}</p>}
      {result && <AddResultMessage result={result} />}
    </form>
  )
}

function AddResultMessage({ result }: { result: AddKeyResult }) {
  if (result.saved) {
    const untested = result.key.status === 'untested'
    return (
      <p className={`mt-1.5 text-xs ${untested ? 'text-warn' : 'text-ok'}`}>
        {untested
          ? `Saved, but couldn’t verify it: ${result.test.message}. Use “Test” later.`
          : `Saved ${result.key.masked}. ${result.test.message} (${result.test.latencyMs} ms).`}
      </p>
    )
  }
  return <p className="selectable mt-1.5 text-xs text-err">{result.message}</p>
}

function LimitsEditor({ provider: p }: { provider: ProviderView }) {
  const save = useIpcMutation('providers:setLimitOverrides', 'providers:list')
  const [draft, setDraft] = useState<Record<keyof Limits, string>>(() => ({
    rpm: p.limitOverrides.rpm?.toString() ?? '',
    rpd: p.limitOverrides.rpd?.toString() ?? '',
    tpm: p.limitOverrides.tpm?.toString() ?? '',
    tpd: p.limitOverrides.tpd?.toString() ?? ''
  }))

  const parsed: Limits = {}
  let invalid = false
  for (const { key } of LIMIT_FIELDS) {
    const v = draft[key].trim()
    if (!v) continue
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) invalid = true
    else parsed[key] = n
  }

  return (
    <div className="mt-3">
      <div className="grid grid-cols-4 gap-3">
        {LIMIT_FIELDS.map(({ key, label }) => (
          <label key={key} className="text-xs text-muted">
            {label}
            <TextInput
              inputMode="numeric"
              value={draft[key]}
              placeholder={p.defaultLimits[key]?.toString() ?? '—'}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              className="mt-1 w-full font-mono"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={invalid || save.isPending} onClick={() => save.mutate([p.id, parsed])}>
          Save overrides
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft({ rpm: '', rpd: '', tpm: '', tpd: '' })
            save.mutate([p.id, {}])
          }}
        >
          Reset to defaults
        </Button>
        <span className="text-xs text-muted">
          {invalid ? 'Use whole positive numbers.' : 'Blank uses the default. Rate-limit headers override these at runtime.'}
        </span>
        <a href={p.docsUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-accent hover:underline">
          Provider limits <ExternalLink size={11} />
        </a>
      </div>
    </div>
  )
}
