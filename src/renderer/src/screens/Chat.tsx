import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Lock, MessageSquarePlus, Pencil, SendHorizontal, Square, Trash2 } from 'lucide-react'
import { create } from 'zustand'
import type { ConversationView, ModelOptions } from '@shared/ipc'
import { Button, TextInput, Toggle } from '../components/ui'
import { MessageView } from '../chat/MessageView'
import { ModelPicker } from '../chat/ModelPicker'
import { invoke, useIpcEvent, useIpcQuery } from '../lib/ipc'
import { timeAgo } from '../lib/format'
import { useNav } from '../store/nav'

/** Remembers the open conversation across screen switches. */
const useActive = create<{ id: string | null; set(id: string | null): void }>((set) => ({ id: null, set: (id) => set({ id }) }))

export function ChatScreen() {
  const qc = useQueryClient()
  const { data: list = [] } = useIpcQuery('chat:list')
  const { data: options, refetch: refetchOptions } = useIpcQuery('chat:modelOptions')
  const onModelsChanged = useCallback(() => void refetchOptions(), [refetchOptions])
  useIpcEvent('models:changed', onModelsChanged)
  const { id: activeId, set: setActive } = useActive()

  // Open the most recent conversation by default.
  useEffect(() => {
    if (!activeId && list.length) setActive(list[0]!.id)
    if (activeId && list.length && !list.some((c) => c.id === activeId)) setActive(list[0]?.id ?? null)
  }, [activeId, list, setActive])

  const newChat = useMutation({
    mutationFn: () => invoke('chat:create'),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['chat:list'] })
      setActive(c.id)
    }
  })
  const remove = useMutation({
    mutationFn: (id: string) => invoke('chat:delete', id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['chat:list'] })
  })

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel/40">
        <div className="p-3">
          <Button variant="primary" className="w-full" onClick={() => newChat.mutate()}>
            <MessageSquarePlus size={15} /> New chat
          </Button>
        </div>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {list.map((c) => (
            <li key={c.id} className="group relative">
              <button
                type="button"
                onClick={() => setActive(c.id)}
                className={`w-full rounded-md px-3 py-2 text-left ${c.id === activeId ? 'bg-panel-2' : 'hover:bg-panel-2/60'}`}
              >
                <div className="flex items-center gap-1.5 truncate pr-6 text-sm">
                  {c.privateMode && <Lock size={11} className="shrink-0 text-ok" />}
                  <span className="truncate">{c.title}</span>
                </div>
                <div className="text-[11px] text-muted">{timeAgo(c.updatedAt)}</div>
              </button>
              <button
                type="button"
                aria-label={`Delete ${c.title}`}
                onClick={() => remove.mutate(c.id)}
                className="absolute top-2 right-2 rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-err/10 hover:text-err"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">No conversations yet.</li>}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {activeId ? (
          <Conversation key={activeId} id={activeId} options={options} />
        ) : (
          <EmptyState onStart={() => newChat.mutate()} hasModels={!!options?.models.length} />
        )}
      </section>
    </div>
  )
}

function NoModelsBanner() {
  const go = useNav((s) => s.go)
  return (
    <div className="mx-auto mb-3 flex max-w-3xl items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-2.5 text-sm text-warn">
      <KeyRound size={16} className="shrink-0" />
      <span className="flex-1">No free model is routable yet. Add a provider key to start chatting.</span>
      <Button size="sm" onClick={() => go('providers')}>
        Add a key
      </Button>
    </div>
  )
}

function EmptyState({ onStart, hasModels }: { onStart: () => void; hasModels: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      {!hasModels && <NoModelsBanner />}
      <h2 className="text-lg font-semibold">Chat with the best free model available</h2>
      <p className="max-w-md text-sm text-muted">
        FreeRouter picks a free, healthy model for each message and fails over automatically when one is rate-limited.
      </p>
      <Button variant="primary" onClick={onStart}>
        <MessageSquarePlus size={15} /> Start a chat
      </Button>
    </div>
  )
}

function Conversation({ id, options }: { id: string; options: ModelOptions | undefined }) {
  const qc = useQueryClient()
  const { data: conv } = useQuery({ queryKey: ['chat:get', id], queryFn: () => invoke('chat:get', id) })
  const [draft, setDraft] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['chat:get', id] })
    void qc.invalidateQueries({ queryKey: ['chat:list'] })
  }
  const onErr = (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  const send = useMutation({ mutationFn: (text: string) => invoke('chat:send', id, text), onSuccess: refresh, onError: onErr })
  const regenerate = useMutation({ mutationFn: (model?: string) => invoke('chat:regenerate', id, model), onSuccess: refresh, onError: onErr })
  const cont = useMutation({ mutationFn: (messageId: string) => invoke('chat:continue', id, messageId), onSuccess: refresh, onError: onErr })
  const setOptions = useMutation({
    mutationFn: (o: { model?: string; privateMode?: boolean }) => invoke('chat:setOptions', id, o),
    onSuccess: (s) => {
      qc.setQueryData<ConversationView>(['chat:get', id], (old) => (old ? { ...old, ...s } : old))
      void qc.invalidateQueries({ queryKey: ['chat:list'] })
    }
  })
  const rename = useMutation({ mutationFn: (title: string) => invoke('chat:rename', id, title), onSuccess: refresh })

  const messages = conv?.messages ?? []
  const streamingMsg = messages.find((m) => m.status === 'streaming')
  const busy = !!streamingMsg || send.isPending || regenerate.isPending || cont.isPending
  const liveLen = messages.length

  // Follow the stream unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  useEffect(() => {
    stick.current = true
  }, [liveLen])

  const submit = () => {
    const text = draft.trim()
    if (!text || busy) return
    setError(null)
    setDraft('')
    stick.current = true
    send.mutate(text)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  if (!conv) return <div className="p-8 text-sm text-muted">Loading…</div>

  return (
    <>
      <header className="flex items-center gap-3 border-b border-border px-5 py-2.5">
        {editingTitle ? (
          <TextInput
            autoFocus
            defaultValue={conv.title}
            aria-label="Conversation title"
            className="w-80"
            onBlur={(e) => {
              setEditingTitle(false)
              rename.mutate(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <button type="button" onClick={() => setEditingTitle(true)} className="group flex min-w-0 items-center gap-2 text-left" title="Rename">
            <h1 className="truncate text-[15px] font-semibold">{conv.title}</h1>
            <Pencil size={12} className="shrink-0 text-muted opacity-0 group-hover:opacity-100" />
          </button>
        )}
        <div className="ml-auto flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-muted" title="Excludes providers that may log or train on prompts">
            <Lock size={12} className={conv.privateMode ? 'text-ok' : ''} /> Private
            <Toggle label="Private mode" checked={conv.privateMode} onChange={(v) => setOptions.mutate({ privateMode: v })} />
          </label>
          <ModelPicker value={conv.model} options={options} onChange={(v) => setOptions.mutate({ model: v })} />
        </div>
      </header>

      <div
        ref={scroller}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
          {!options?.models.length && <NoModelsBanner />}
          {messages.length === 0 && (
            <p className="pt-16 text-center text-sm text-muted">
              Ask anything. Replies come from <span className="text-fg">{conv.model === 'auto' ? 'the best free model available' : conv.model}</span>.
            </p>
          )}
          {messages.map((m, i) => (
            <MessageView
              key={m.id}
              m={m}
              isLast={i === messages.length - 1}
              busy={busy}
              options={options}
              onRegenerate={(model) => regenerate.mutate(model)}
              onContinue={() => cont.mutate(m.id)}
              onStop={() => void invoke('chat:stop', m.id)}
            />
          ))}
        </div>
      </div>

      <footer className="border-t border-border px-6 py-3">
        <div className="mx-auto max-w-3xl">
          {error && <p className="mb-2 text-xs text-err">{error}</p>}
          <div className="flex items-end gap-2 rounded-xl border border-border bg-panel px-3 py-2 focus-within:border-accent">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              rows={Math.min(8, Math.max(1, draft.split('\n').length))}
              placeholder="Message FreeRouter…  (Enter to send, Shift+Enter for a new line)"
              aria-label="Message"
              className="selectable max-h-60 flex-1 resize-none bg-transparent py-1 text-[14px] outline-none placeholder:text-muted/70"
            />
            {streamingMsg ? (
              <Button variant="secondary" onClick={() => void invoke('chat:stop', streamingMsg.id)} aria-label="Stop">
                <Square size={13} /> Stop
              </Button>
            ) : (
              <Button variant="primary" onClick={submit} disabled={!draft.trim() || busy} aria-label="Send">
                <SendHorizontal size={15} />
              </Button>
            )}
          </div>
        </div>
      </footer>
    </>
  )
}
