/**
 * A fake OpenAI-compatible provider (PRD §12): a real HTTP server whose models follow scripts,
 * so router tests exercise real fetch, SSE parsing, timeouts and broken sockets.
 *
 * Routes: GET /<provider>/v1/models, POST /<provider>/v1/chat/completions
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Behavior =
  | { kind: 'ok'; text?: string; firstDelayMs?: number; chunkDelayMs?: number; usage?: boolean; headers?: Record<string, string> }
  | { kind: 'status'; status: number; body?: unknown; headers?: Record<string, string> }
  /** Sends `afterChunks` content chunks, then destroys the socket. */
  | { kind: 'break'; afterChunks: number }
  /** 200 + SSE headers, then nothing. */
  | { kind: 'hang' }
  /** Sends only the role chunk, then nothing. */
  | { kind: 'roleThenHang' }
  /** `data: {"error":…}` inside a 200 stream, before any token. */
  | { kind: 'streamError'; code: number; message: string }
  /** Streams one tool call in fragments, finish_reason tool_calls. */
  | { kind: 'tools'; name: string; args: string }
  /** Ignores stream:true and answers with a plain JSON completion. */
  | { kind: 'json'; text: string }

export interface FakeModel {
  id: string
  context_length?: number
  supported_parameters?: string[]
  input_modalities?: string[]
}

export interface RecordedRequest {
  provider: string
  model: string
  body: Record<string, unknown>
  headers: IncomingMessage['headers']
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class FakeProvider {
  private server: Server | null = null
  private readonly scripts = new Map<string, Behavior[]>()
  private readonly models = new Map<string, FakeModel[]>()
  private readonly open = new Set<ServerResponse>()
  readonly requests: RecordedRequest[] = []
  baseUrl = ''

  /** Models listed by GET /<provider>/v1/models. */
  setModels(provider: string, models: FakeModel[]): this {
    this.models.set(provider, models)
    return this
  }

  /** Queue behaviors for `<provider>:<model>`; the last one repeats. Default is `ok`. */
  script(provider: string, model: string, ...behaviors: Behavior[]): this {
    this.scripts.set(`${provider}:${model}`, behaviors)
    return this
  }

  callsTo(provider: string, model?: string): RecordedRequest[] {
    return this.requests.filter((r) => r.provider === provider && (!model || r.model === model))
  }

  private next(provider: string, model: string): Behavior {
    const list = this.scripts.get(`${provider}:${model}`)
    if (!list || list.length === 0) return { kind: 'ok' }
    return list.length > 1 ? list.shift()! : list[0]!
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this.baseUrl
  }

  async stop(): Promise<void> {
    for (const res of this.open) res.destroy()
    this.server?.closeAllConnections()
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r())
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const m = /^\/([\w-]+)\/v1\/(models|chat\/completions)$/.exec(req.url ?? '')
    if (!m) return void res.writeHead(404).end()
    const provider = m[1]!
    if (m[2] === 'models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return void res.end(JSON.stringify({ data: this.models.get(provider) ?? [] }))
    }

    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw) as Record<string, unknown>
    const model = String(body['model'])
    this.requests.push({ provider, model, body, headers: req.headers })
    this.open.add(res)
    res.on('close', () => this.open.delete(res))
    await this.respond(this.next(provider, model), model, res)
  }

  private async respond(b: Behavior, model: string, res: ServerResponse): Promise<void> {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) =>
      `data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
    const sse = (headers: Record<string, string> = {}) =>
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers })

    switch (b.kind) {
      case 'status':
        res.writeHead(b.status, { 'content-type': 'application/json', ...(b.headers ?? {}) })
        return void res.end(JSON.stringify(b.body ?? { error: { message: `fake ${b.status}` } }))
      case 'json':
        res.writeHead(200, { 'content-type': 'application/json' })
        return void res.end(
          JSON.stringify({
            id: 'chatcmpl-json',
            object: 'chat.completion',
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: b.text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
          })
        )
      case 'hang':
        sse()
        return // never ends; the router's timer must give up
      case 'roleThenHang':
        sse()
        res.write(chunk({ role: 'assistant', content: '' }))
        return
      case 'streamError':
        sse()
        res.write(`data: ${JSON.stringify({ error: { code: b.code, message: b.message } })}\n\n`)
        return void res.end()
      case 'break': {
        sse()
        res.write(chunk({ role: 'assistant', content: '' }))
        for (let i = 0; i < b.afterChunks; i++) {
          res.write(chunk({ content: `part${i} ` }))
          await sleep(5)
        }
        res.socket?.destroy()
        return
      }
      case 'tools': {
        sse()
        res.write(chunk({ role: 'assistant', content: null }))
        const id = 'call_fake_1'
        res.write(chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: b.name, arguments: '' } }] }))
        const half = Math.ceil(b.args.length / 2)
        for (const part of [b.args.slice(0, half), b.args.slice(half)]) {
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] }))
        }
        res.write(chunk({}, 'tool_calls', { usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } }))
        res.write('data: [DONE]\n\n')
        return void res.end()
      }
      case 'ok': {
        if (b.firstDelayMs) await sleep(b.firstDelayMs)
        if (res.destroyed) return
        sse(b.headers)
        res.write(': keep-alive comment\n\n')
        res.write(chunk({ role: 'assistant', content: '' }))
        const words = (b.text ?? `Hello from ${model}`).split(/(?<= )/)
        for (const w of words) {
          if (b.chunkDelayMs) await sleep(b.chunkDelayMs)
          if (res.destroyed) return
          res.write(chunk({ content: w }))
        }
        const usage = b.usage === false ? {} : { usage: { prompt_tokens: 11, completion_tokens: words.length, total_tokens: 11 + words.length } }
        res.write(chunk({}, 'stop', usage))
        res.write('data: [DONE]\n\n')
        return void res.end()
      }
    }
  }
}
