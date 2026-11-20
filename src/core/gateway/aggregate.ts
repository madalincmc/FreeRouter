import type { ChatChunk } from '../routing/types'

interface ToolCallAcc {
  id?: string
  type: string
  function: { name: string; arguments: string }
}

interface ChoiceAcc {
  content: string
  reasoning: string
  toolCalls: Map<number, ToolCallAcc>
  finishReason: string | null
  role: string
}

/** Folds normalised stream chunks into one non-streamed `chat.completion` (PRD §8). */
export class CompletionAggregator {
  private readonly choices = new Map<number, ChoiceAcc>()

  add(chunk: ChatChunk): void {
    for (const ch of chunk.choices ?? []) {
      const acc = this.choices.get(ch.index) ?? { content: '', reasoning: '', toolCalls: new Map(), finishReason: null, role: 'assistant' }
      this.choices.set(ch.index, acc)
      const d = ch.delta ?? {}
      if (typeof d.role === 'string') acc.role = d.role
      if (typeof d.content === 'string') acc.content += d.content
      if (typeof d.reasoning === 'string') acc.reasoning += d.reasoning
      for (const raw of (d.tool_calls as { index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[]) ?? []) {
        const tc = acc.toolCalls.get(raw.index) ?? { type: 'function', function: { name: '', arguments: '' } }
        if (raw.id) tc.id = raw.id
        if (raw.type) tc.type = raw.type
        if (raw.function?.name) tc.function.name += raw.function.name
        if (raw.function?.arguments) tc.function.arguments += raw.function.arguments
        acc.toolCalls.set(raw.index, tc)
      }
      if (ch.finish_reason) acc.finishReason = ch.finish_reason
    }
  }

  result(meta: {
    id: string
    created: number
    model: string
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }): Record<string, unknown> {
    const choices = [...this.choices.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => {
        const toolCalls = [...c.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, t]) => t)
        const message: Record<string, unknown> = {
          role: 'assistant',
          content: c.content.length || toolCalls.length === 0 ? c.content : null
        }
        if (toolCalls.length) message['tool_calls'] = toolCalls
        if (c.reasoning) message['reasoning'] = c.reasoning
        return { index, message, finish_reason: c.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'), logprobs: null }
      })
    return {
      id: meta.id,
      object: 'chat.completion',
      created: meta.created,
      model: meta.model,
      choices: choices.length ? choices : [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop', logprobs: null }],
      usage: meta.usage
    }
  }
}
