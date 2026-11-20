import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { create } from 'zustand'
import type { AttemptView, ChatEvent, ConversationView } from '@shared/ipc'

/** Streaming state per assistant message, appended to the stored content while it streams. */
export interface LiveReply {
  content: string
  reasoning: string
  provider?: string
  model?: string
  attempts?: AttemptView[]
}

interface LiveState {
  live: Record<string, LiveReply>
  apply(e: Exclude<ChatEvent, { type: 'end' }>): void
  clear(messageId: string): void
}

export const useLive = create<LiveState>((set) => ({
  live: {},
  apply: (e) =>
    set((s) => {
      const prev = s.live[e.messageId] ?? { content: '', reasoning: '' }
      const next: LiveReply =
        e.type === 'start'
          ? { ...prev, provider: e.provider, model: e.model, attempts: e.attempts }
          : { ...prev, content: prev.content + e.content, reasoning: prev.reasoning + e.reasoning }
      return { live: { ...s.live, [e.messageId]: next } }
    }),
  clear: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.live
      return { live: rest }
    })
}))

/** Subscribes once to `chat:event` and keeps the query cache in sync. */
export function useChatEvents(): void {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.freerouter.on('chat:event', (e) => {
        if (e.type !== 'end') {
          useLive.getState().apply(e)
          return
        }
        // Swap the live text for the final stored message in one step (no flicker).
        const cached = qc.getQueryData<ConversationView>(['chat:get', e.conversationId])
        if (cached?.messages.some((m) => m.id === e.message.id)) {
          qc.setQueryData<ConversationView>(['chat:get', e.conversationId], {
            ...cached,
            messages: cached.messages.map((m) => (m.id === e.message.id ? e.message : m))
          })
        } else {
          void qc.invalidateQueries({ queryKey: ['chat:get', e.conversationId] })
        }
        useLive.getState().clear(e.message.id)
        void qc.invalidateQueries({ queryKey: ['chat:list'] })
        void qc.invalidateQueries({ queryKey: ['models:list'] })
      }),
    [qc]
  )
}
