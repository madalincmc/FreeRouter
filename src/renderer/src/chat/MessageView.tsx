import { useState } from 'react'
import { AlertTriangle, Brain, ChevronDown, ChevronRight, Loader2, PlayCircle, RotateCcw, Square } from 'lucide-react'
import type { AttemptView, ChatMessageView, ModelOptions } from '@shared/ipc'
import { Badge, Button } from '../components/ui'
import { useLive } from './live'
import { CopyButton, Markdown } from './Markdown'
import { ModelPicker } from './ModelPicker'

const FAILURE_LABEL: Record<string, string> = {
  rate_limited: 'rate-limited',
  quota_exhausted: 'daily quota',
  payment: 'needs credits',
  auth: 'key rejected',
  context: 'context too long',
  bad_request: 'bad request',
  not_found: 'model gone',
  server: 'server error',
  timeout: 'timeout',
  network: 'network'
}

function AttemptList({ attempts }: { attempts: AttemptView[] }) {
  return (
    <ol className="mt-1.5 space-y-0.5 text-[11px]">
      {attempts.map((a, i) => (
        <li key={i} className="flex gap-2 font-mono">
          <span className={a.outcome === 'ok' ? 'text-ok' : a.outcome === 'skipped' ? 'text-muted' : 'text-err'}>
            {a.outcome === 'ok' ? '✓' : a.outcome === 'skipped' ? '–' : '✗'}
          </span>
          <span className="text-fg">{a.model}</span>
          <span className="text-muted">
            {a.outcome === 'ok' ? `${a.ms} ms to first token` : `${FAILURE_LABEL[a.failure ?? ''] ?? a.outcome}${a.status ? ` (${a.status})` : ''}`}
            {a.message && a.outcome !== 'ok' ? ` – ${a.message}` : ''}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** Per-message badge: provider, model, latency and attempts (PRD §9). */
function ReplyBadge({ m, provider, model, attempts }: { m: ChatMessageView; provider?: string; model?: string; attempts?: AttemptView[] }) {
  const [open, setOpen] = useState(false)
  // Only failures before the first token are fallbacks; a mid-stream break is shown as an error.
  const failed = attempts?.filter((a) => a.outcome === 'failed' || a.outcome === 'skipped').length ?? 0
  if (!model && !attempts?.length) return null
  return (
    <div className="mt-2 text-[11px] text-muted">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex flex-wrap items-center gap-1.5 hover:text-fg" aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {model && <span className="font-mono text-fg/80">{model}</span>}
        {provider && <span>via {provider}</span>}
        {m.meta.ttftMs !== undefined && <span>· {m.meta.ttftMs} ms first token</span>}
        {m.meta.latencyMs !== undefined && <span>· {(m.meta.latencyMs / 1000).toFixed(1)} s total</span>}
        {m.meta.usage && (
          <span>
            · {m.meta.usage.completion_tokens}
            {m.meta.usage.estimated ? '≈' : ''} tokens
          </span>
        )}
        {failed > 0 && (
          <Badge tone="warn">
            {failed} fallback{failed > 1 ? 's' : ''}
          </Badge>
        )}
        {!!m.meta.continuedFrom?.length && <Badge>continued from {m.meta.continuedFrom.join(', ')}</Badge>}
        {m.meta.requested && m.meta.requested !== 'auto' && <Badge>asked: {m.meta.requested}</Badge>}
      </button>
      {open && attempts && <AttemptList attempts={attempts} />}
    </div>
  )
}

export function MessageView({
  m,
  isLast,
  busy,
  options,
  onRegenerate,
  onContinue,
  onStop
}: {
  m: ChatMessageView
  isLast: boolean
  busy: boolean
  options: ModelOptions | undefined
  onRegenerate: (model?: string) => void
  onContinue: () => void
  onStop: () => void
}) {
  const live = useLive((s) => s.live[m.id])
  const [showThinking, setShowThinking] = useState(false)
  const [pickRegen, setPickRegen] = useState(false)

  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-[14px] whitespace-pre-wrap">{m.content}</div>
      </div>
    )
  }

  const streaming = m.status === 'streaming'
  const content = streaming ? m.content + (live?.content ?? '') : m.content
  const reasoning = streaming ? (m.meta.reasoning ?? '') + (live?.reasoning ?? '') : m.meta.reasoning
  const provider = live?.provider ?? m.meta.provider
  const model = live?.model ?? m.meta.model
  const attempts = live?.attempts ?? m.meta.attempts
  const canContinue = (m.status === 'error' || m.status === 'stopped') && content.trim().length > 0

  return (
    <div className="group">
      {reasoning && (
        <div className="mb-2">
          <button type="button" onClick={() => setShowThinking((v) => !v)} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
            <Brain size={13} /> {streaming && !content ? 'Thinking…' : 'Thinking'}
            {showThinking ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {showThinking && (
            <div className="selectable mt-1.5 border-l-2 border-border pl-3 text-[13px] whitespace-pre-wrap text-muted">{reasoning}</div>
          )}
        </div>
      )}

      {content ? (
        <Markdown text={content} />
      ) : streaming ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" />
          {model ? `Waiting for ${model}…` : 'Finding a free model…'}
        </div>
      ) : null}
      {streaming && content && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />}

      {m.status === 'error' && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs text-err">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="selectable">{m.meta.midStream ? 'The answer was cut off. ' : ''}{m.meta.error}</span>
        </div>
      )}
      {m.status === 'stopped' && <div className="mt-1 text-xs text-muted">Stopped.</div>}

      <ReplyBadge m={m} provider={provider} model={model} attempts={attempts} />

      <div className={`mt-1.5 flex flex-wrap items-center gap-1 ${isLast || streaming ? '' : 'opacity-0 group-hover:opacity-100'}`}>
        {streaming ? (
          <Button size="sm" variant="ghost" onClick={onStop}>
            <Square size={11} /> Stop
          </Button>
        ) : (
          <>
            {content && <CopyButton text={content} />}
            {canContinue && isLast && (
              <Button size="sm" variant="ghost" onClick={onContinue} disabled={busy} title="Resume this answer on a different model">
                <PlayCircle size={12} /> Continue with another model
              </Button>
            )}
            {isLast && !pickRegen && (
              <>
                <Button size="sm" variant="ghost" onClick={() => onRegenerate()} disabled={busy}>
                  <RotateCcw size={12} /> {m.status === 'error' ? 'Retry' : 'Regenerate'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPickRegen(true)} disabled={busy}>
                  Regenerate with…
                </Button>
              </>
            )}
            {isLast && pickRegen && (
              <span className="flex items-center gap-1">
                <ModelPicker
                  value=""
                  placeholder="Pick a model…"
                  options={options}
                  label="Regenerate with"
                  className="h-7 text-xs"
                  onChange={(v) => {
                    setPickRegen(false)
                    onRegenerate(v)
                  }}
                />
                <Button size="sm" variant="ghost" onClick={() => setPickRegen(false)}>
                  Cancel
                </Button>
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}
