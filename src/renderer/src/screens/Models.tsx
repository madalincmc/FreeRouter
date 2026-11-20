import { Fragment, useCallback, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Zap } from 'lucide-react'
import type { CapabilityTag, ModelState, ModelTestResult, ModelView, ProviderView, QualityProfile } from '@shared/ipc'
import { Badge, Button, Card, Dot, Page, TextInput, Toggle } from '../components/ui'
import { invoke, useIpcEvent, useIpcMutation, useIpcQuery } from '../lib/ipc'
import { compactNumber, timeAgo } from '../lib/format'

const STATE_TONE: Record<ModelState, 'ok' | 'warn' | 'err' | 'neutral'> = {
  healthy: 'ok',
  degraded: 'warn',
  cooling_down: 'warn',
  quota_exhausted: 'err',
  gone: 'neutral'
}
const STATE_LABEL: Record<ModelState, string> = {
  healthy: 'healthy',
  degraded: 'degraded',
  cooling_down: 'cooling down',
  quota_exhausted: 'quota exhausted',
  gone: 'gone'
}
const TAG_LABEL: Record<CapabilityTag, string> = {
  coding: 'coding',
  reasoning: 'reasoning',
  tools: 'tools',
  vision: 'vision',
  long_context: 'long ctx',
  fast: 'fast'
}
const PROFILES: QualityProfile[] = ['general', 'coding', 'reasoning', 'tools']

type SortKey = 'quality' | 'name' | 'latency' | 'context'

interface Filters {
  freeOnly: boolean
  coding: boolean
  tools: boolean
  healthy: boolean
  hideGone: boolean
  provider: string
  search: string
  sort: SortKey
}

export function ModelsScreen() {
  const qc = useQueryClient()
  const { data: models = [], isLoading } = useIpcQuery('models:list')
  const { data: providers = [] } = useIpcQuery('providers:list')
  const { data: syncStatus = [] } = useIpcQuery('models:syncStatus')
  const { data: usage } = useIpcQuery('models:usageToday')
  const [filters, setFilters] = useState<Filters>({
    freeOnly: true,
    coding: false,
    tools: false,
    healthy: false,
    hideGone: true,
    provider: 'all',
    search: '',
    sort: 'quality'
  })
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['models:list'] })
    void qc.invalidateQueries({ queryKey: ['models:syncStatus'] })
    void qc.invalidateQueries({ queryKey: ['providers:list'] })
    void qc.invalidateQueries({ queryKey: ['models:usageToday'] })
  }, [qc])
  useIpcEvent('models:changed', refresh)

  const sync = useMutation({ mutationFn: () => invoke('models:sync'), onSettled: refresh })
  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers])

  const visible = useMemo(() => {
    const q = filters.search.trim().toLowerCase()
    const list = models.filter(
      (m) =>
        (!filters.freeOnly || m.isFree) &&
        (!filters.coding || m.tags.includes('coding')) &&
        (!filters.tools || m.tags.includes('tools')) &&
        (!filters.healthy || m.state === 'healthy') &&
        (!filters.hideGone || m.state !== 'gone') &&
        (filters.provider === 'all' || m.providerId === filters.provider) &&
        (!q || m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q))
    )
    const cmp: Record<SortKey, (a: ModelView, b: ModelView) => number> = {
      quality: (a, b) => (b.quality.general ?? 0) - (a.quality.general ?? 0),
      name: (a, b) => a.displayName.localeCompare(b.displayName),
      latency: (a, b) => (a.p50LatencyMs ?? Infinity) - (b.p50LatencyMs ?? Infinity),
      context: (a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0)
    }
    return list.sort(cmp[filters.sort])
  }, [models, filters])

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setFilters((f) => ({ ...f, [k]: v }))
  const lastSync = Math.max(0, ...syncStatus.map((s) => s.lastSuccessAt ?? 0)) || null
  const freeTotal = models.filter((m) => m.isFree && m.state !== 'gone').length

  return (
    <Page title="Models" subtitle="Live registry of models from your providers. Only free models are routed.">
      <SyncBar
        providers={providers}
        status={syncStatus}
        lastSync={lastSync}
        freeTotal={freeTotal}
        syncing={sync.isPending}
        onSync={() => sync.mutate()}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <TextInput
            placeholder="Search models"
            aria-label="Search models"
            value={filters.search}
            onChange={(e) => set('search', e.target.value)}
            className="w-56 pl-8"
          />
        </div>
        <select
          aria-label="Provider"
          value={filters.provider}
          onChange={(e) => set('provider', e.target.value)}
          className="h-8 rounded-md border border-border bg-bg px-2 text-sm"
        >
          <option value="all">All providers</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Chip on={filters.freeOnly} onClick={() => set('freeOnly', !filters.freeOnly)}>
          Free only
        </Chip>
        <Chip on={filters.coding} onClick={() => set('coding', !filters.coding)}>
          Coding
        </Chip>
        <Chip on={filters.tools} onClick={() => set('tools', !filters.tools)}>
          Tools
        </Chip>
        <Chip on={filters.healthy} onClick={() => set('healthy', !filters.healthy)}>
          Healthy
        </Chip>
        <Chip on={!filters.hideGone} onClick={() => set('hideGone', !filters.hideGone)}>
          Show gone
        </Chip>
        <label className="ml-auto flex items-center gap-2 text-xs text-muted">
          Sort
          <select
            value={filters.sort}
            onChange={(e) => set('sort', e.target.value as SortKey)}
            className="h-8 rounded-md border border-border bg-bg px-2 text-sm text-fg"
          >
            <option value="quality">Quality</option>
            <option value="latency">Latency</option>
            <option value="context">Context</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>

      <Card className="overflow-hidden p-0">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b border-border bg-panel-2/50 text-left text-xs text-muted">
              <th className="w-8 py-2 pl-3" />
              <th className="py-2 pr-2 font-medium">Model</th>
              <th className="w-[22%] py-2 pr-2 font-medium">Tags</th>
              <th className="w-16 py-2 pr-2 text-right font-medium">Context</th>
              <th className="w-14 py-2 pr-2 text-right font-medium" title="General quality score (0–100)">
                Quality
              </th>
              <th className="w-16 py-2 pr-2 text-right font-medium" title="Median latency of recent calls">
                p50
              </th>
              <th className="w-20 py-2 pr-2 text-right font-medium" title="Requests today / provider daily limit">
                Today
              </th>
              <th className="w-[124px] py-2 pr-3" />
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => (
              <ModelRow
                key={m.id}
                m={m}
                provider={providerById.get(m.providerId)}
                usedToday={
                  providerById.get(m.providerId)?.limitScope === 'account'
                    ? (usage?.perProvider[m.providerId] ?? 0)
                    : (usage?.perModel[m.id] ?? 0)
                }
                expanded={expanded === m.id}
                onToggleExpand={() => setExpanded((e) => (e === m.id ? null : m.id))}
              />
            ))}
          </tbody>
        </table>
        {!isLoading && visible.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-muted">
            {models.length === 0
              ? 'No models yet. Sync runs at startup; OpenRouter works without a key, other providers need one.'
              : 'No models match these filters.'}
          </p>
        )}
      </Card>
      <p className="mt-2 text-xs text-muted">
        Showing {visible.length} of {models.length} models.
      </p>
    </Page>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-8 rounded-md border px-2.5 text-xs font-medium transition-colors ${
        on ? 'border-accent/60 bg-accent/15 text-accent' : 'border-border text-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  )
}

function SyncBar(props: {
  providers: ProviderView[]
  status: { providerId: string; lastSuccessAt: number | null; lastError: string | null; freeCount: number }[]
  lastSync: number | null
  freeTotal: number
  syncing: boolean
  onSync: () => void
}) {
  const names = new Map(props.providers.map((p) => [p.id, p.name]))
  return (
    <Card className="mb-4 py-3">
      <div className="flex items-center gap-4">
        <div className="text-sm">
          <span className="font-semibold">{props.freeTotal}</span> <span className="text-muted">free models</span>
          <span className="mx-2 text-border">|</span>
          <span className="text-muted">synced {timeAgo(props.lastSync)} · every 6 h</span>
        </div>
        <div className="flex flex-1 flex-wrap gap-1.5">
          {props.status.map((s) => {
            const tone = s.lastError ? 'err' : s.lastSuccessAt ? 'ok' : 'neutral'
            const title = s.lastError
              ? `Last sync failed: ${s.lastError}`
              : s.lastSuccessAt
                ? `Synced ${timeAgo(s.lastSuccessAt)}`
                : 'Not synced yet (needs a key unless the list is public)'
            return (
              <Badge key={s.providerId} tone={tone} title={title}>
                {names.get(s.providerId) ?? s.providerId} · {s.freeCount}
              </Badge>
            )
          })}
        </div>
        <Button onClick={props.onSync} disabled={props.syncing}>
          <RefreshCw size={14} className={props.syncing ? 'animate-spin' : ''} />
          {props.syncing ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>
    </Card>
  )
}

function ModelRow({
  m,
  provider,
  usedToday,
  expanded,
  onToggleExpand
}: {
  m: ModelView
  provider: ProviderView | undefined
  usedToday: number
  expanded: boolean
  onToggleExpand: () => void
}) {
  const qc = useQueryClient()
  const setEnabled = useIpcMutation('models:setEnabled')
  const [result, setResult] = useState<ModelTestResult>()
  const test = useMutation({
    mutationFn: () => invoke('models:test', m.id),
    onSuccess: (r) => {
      setResult(r)
      void qc.invalidateQueries({ queryKey: ['models:list'] })
    }
  })
  const rpd = provider ? (provider.limitOverrides.rpd ?? provider.defaultLimits.rpd) : undefined
  const hasKey = !!provider?.keys.some((k) => k.enabled && k.status !== 'invalid')
  const dim = !m.enabled || m.state === 'gone' || !m.isFree || !hasKey

  return (
    <Fragment>
      <tr className={`border-b border-border last:border-0 hover:bg-panel-2/40 ${dim ? 'opacity-60' : ''}`}>
        <td className="py-2 pl-3 align-top">
          <button type="button" onClick={onToggleExpand} aria-label="Details" aria-expanded={expanded} className="mt-0.5 text-muted hover:text-fg">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </td>
        <td className="min-w-0 py-2 pr-2 align-top">
          <div className="flex min-w-0 items-center gap-2">
            <span title={hasKey ? STATE_LABEL[m.state] : 'not routable: no key'}>
              <Dot tone={hasKey ? STATE_TONE[m.state] : 'neutral'} />
            </span>
            <span className="truncate font-medium" title={m.displayName}>
              {m.displayName}
            </span>
            {m.isNew && <Badge tone="accent">new</Badge>}
            {!m.isFree && <Badge>paid</Badge>}
            {!hasKey && <Badge title={`Add a key for ${provider?.name ?? m.providerId} to route to this model`}>no key</Badge>}
          </div>
          <div className="selectable truncate pl-4 font-mono text-[11px] text-muted" title={m.id}>
            {m.id}
          </div>
          {m.lastError && m.state !== 'healthy' && (
            <div className="selectable truncate pl-4 text-[11px] text-warn" title={m.lastError}>
              {STATE_LABEL[m.state]}: {m.lastError}
            </div>
          )}
        </td>
        <td className="py-2 pr-2 align-top">
          <div className="flex flex-wrap gap-1">
            {m.tags.map((t) => (
              <span key={t} className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">
                {TAG_LABEL[t]}
              </span>
            ))}
          </div>
        </td>
        <td className="py-2 pr-2 text-right align-top font-mono text-xs">{m.contextWindow ? compactNumber(m.contextWindow) : '—'}</td>
        <td className="py-2 pr-2 text-right align-top font-mono text-xs">
          {m.quality.general ?? '—'}
          {m.qualityOverridden.length > 0 && <span className="text-accent" title="Edited by you">*</span>}
        </td>
        <td className="py-2 pr-2 text-right align-top font-mono text-xs">{m.p50LatencyMs !== null ? `${m.p50LatencyMs} ms` : '—'}</td>
        <td
          className={`py-2 pr-2 text-right align-top font-mono text-xs ${rpd && usedToday >= rpd ? 'text-err' : 'text-muted'}`}
          title={
            provider?.limitScope === 'account'
              ? 'Requests today across all models of this provider (shared account limit)'
              : 'Requests today / provider daily limit'
          }
        >
          {usedToday} / {rpd ? compactNumber(rpd) : '?'}
        </td>
        <td className="py-2 pr-3 align-top">
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending || m.state === 'gone'} title="Send a tiny real request">
              {test.isPending ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} Test
            </Button>
            <Toggle
              label={m.enabled ? 'Disable model' : 'Enable model'}
              checked={m.enabled}
              disabled={setEnabled.isPending}
              onChange={(on) => setEnabled.mutate([m.id, on], { onSuccess: () => void qc.invalidateQueries({ queryKey: ['models:list'] }) })}
            />
          </div>
        </td>
      </tr>
      {result && (
        <tr className="border-b border-border">
          <td />
          <td colSpan={7} className={`selectable pb-2 pl-4 text-xs ${result.ok ? 'text-ok' : 'text-err'}`}>
            {result.message}
            {result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}
          </td>
        </tr>
      )}
      {expanded && (
        <tr className="border-b border-border bg-bg/40">
          <td />
          <td colSpan={7} className="py-3 pr-3">
            <ModelDetails key={JSON.stringify(m.quality)} m={m} />
          </td>
        </tr>
      )}
    </Fragment>
  )
}

function ModelDetails({ m }: { m: ModelView }) {
  const qc = useQueryClient()
  const save = useIpcMutation('models:setQuality')
  const [draft, setDraft] = useState<Record<QualityProfile, string>>(() =>
    Object.fromEntries(PROFILES.map((p) => [p, String(m.quality[p] ?? '')])) as Record<QualityProfile, string>
  )
  const onSaved = { onSuccess: () => void qc.invalidateQueries({ queryKey: ['models:list'] }) }

  const commit = (p: QualityProfile) => {
    const n = Number(draft[p])
    if (draft[p].trim() === '' || !Number.isInteger(n) || n < 0 || n > 100) return
    if (n !== m.quality[p]) save.mutate([m.id, { [p]: n }], onSaved)
  }

  return (
    <div className="grid grid-cols-[1fr_auto] gap-6">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">Max output</dt>
        <dd className="font-mono">{m.maxOutput ? compactNumber(m.maxOutput) : '—'}</dd>
        <dt className="text-muted">First seen</dt>
        <dd>{timeAgo(m.firstSeen)}</dd>
        <dt className="text-muted">Last listed</dt>
        <dd>{timeAgo(m.lastSeen)}</dd>
        <dt className="text-muted">Last tested</dt>
        <dd>{timeAgo(m.lastTestedAt)}</dd>
        {m.cooldownUntil && m.cooldownUntil > Date.now() && (
          <>
            <dt className="text-muted">Cooldown until</dt>
            <dd>{new Date(m.cooldownUntil).toLocaleTimeString()}</dd>
          </>
        )}
      </dl>
      <div>
        <div className="mb-1.5 text-xs text-muted">Quality scores (0–100) used for routing</div>
        <div className="flex gap-2">
          {PROFILES.map((p) => (
            <label key={p} className="text-[11px] text-muted">
              <span className="capitalize">{p}</span>
              {m.qualityOverridden.includes(p) && (
                <button
                  type="button"
                  className="ml-1 text-accent hover:underline"
                  title="Reset to the seeded value"
                  onClick={() => {
                    save.mutate([m.id, { [p]: null }], onSaved)
                    setDraft((d) => ({ ...d, [p]: '' }))
                  }}
                >
                  reset
                </button>
              )}
              <TextInput
                inputMode="numeric"
                value={draft[p]}
                onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}
                onBlur={() => commit(p)}
                onKeyDown={(e) => e.key === 'Enter' && commit(p)}
                className={`mt-1 w-16 font-mono ${m.qualityOverridden.includes(p) ? 'border-accent/60' : ''}`}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
