import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Attempt, ChatChunk, ChatRequest, RouteOptions, RouterEvent } from '../routing/types'
import { redact } from '../security/redact'
import { CompletionAggregator } from './aggregate'

export interface GatewayModel {
  id: string
  owned_by: string
  context_length?: number | null
}

export interface GatewayDeps {
  route(req: ChatRequest, opts: RouteOptions): AsyncGenerator<RouterEvent>
  /** Virtual models, chains and routable concrete models (PRD §8 GET /v1/models). */
  listModels(): GatewayModel[]
  healthyCount(): number
  /** Current gateway token (read per request, so regenerating takes effect immediately). */
  token(): string
  /** Browser origins allowed to call the gateway (empty by default). */
  allowedOrigins(): string[]
  /** Private mode for gateway traffic (M6 setting); a request can also ask via `x-fr-private: 1`. */
  privateMode?(): boolean
  version: string
}

export const TOKEN_PREFIX = 'fr-local-'

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(24).toString('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function openAiError(reply: FastifyReply, status: number, message: string, type: string, code: string | null) {
  return reply.code(status).send({ error: { message: redact(message), type, code, param: null } })
}

const ChatBodySchema = z
  .object({
    model: z.string().max(256).optional(),
    messages: z
      .array(z.object({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']) }).passthrough())
      .min(1),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullable().optional()
  })
  .passthrough()

const attemptsHeader = (attempts: Attempt[]): string => String(attempts.filter((a) => a.outcome !== 'skipped').length)

/** Standard OpenAI usage fields only (our internal `estimated` flag stays internal). */
const openAiUsage = (u: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => ({
  prompt_tokens: u.prompt_tokens,
  completion_tokens: u.completion_tokens,
  total_tokens: u.total_tokens
})

/**
 * The local OpenAI-compatible gateway (PRD §7, §8). Binds to 127.0.0.1 only; every /v1 request
 * needs the local gateway token; browser origins and foreign Host headers are refused.
 */
export function buildGateway(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024, return503OnClosing: true })

  app.addHook('onRequest', async (req, reply) => {
    // DNS-rebinding guard: only our own loopback host names on the port we actually bound.
    const port = (app.server.address() as AddressInfo | null)?.port
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return openAiError(reply, 403, 'Forbidden host', 'forbidden', 'bad_host')
    }

    // Drive-by protection: browsers always send Origin on cross-site requests.
    const origin = req.headers.origin
    if (origin && !deps.allowedOrigins().includes(origin)) {
      return openAiError(reply, 403, 'Browser requests are not allowed (Origin not allow-listed)', 'forbidden', 'origin_not_allowed')
    }

    if (req.url.startsWith('/v1/')) {
      const auth = req.headers.authorization
      const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined
      const presented = bearer ?? (req.headers['x-api-key'] as string | undefined)
      if (!presented || !safeEqual(presented, deps.token())) {
        return openAiError(
          reply,
          401,
          'Invalid or missing gateway token. Use the fr-local-… token from FreeRouter → Gateway as your API key.',
          'invalid_request_error',
          'invalid_api_key'
        )
      }
    }
  })

  app.get('/health', async () => ({ status: 'ok', version: deps.version, healthyModels: deps.healthyCount() }))

  app.get('/v1/models', async () => ({
    object: 'list',
    data: deps.listModels().map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.owned_by,
      ...(m.context_length ? { context_length: m.context_length } : {})
    }))
  }))

  app.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ChatBodySchema.safeParse(req.body)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return openAiError(reply, 400, `Invalid request: ${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`.trim(), 'invalid_request_error', 'invalid_request')
    }
    const body = parsed.data as unknown as ChatRequest & { stream_options?: { include_usage?: boolean } | null }
    const minContextHeader = Number(req.headers['x-fr-min-context'])
    const controller = new AbortController()
    // Client hung up → cancel upstream (frees the provider connection and the quota slot).
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) controller.abort()
    })

    const opts: RouteOptions = {
      source: 'gateway',
      clientUa: (req.headers['user-agent'] ?? '').slice(0, 200) || undefined,
      minContext: Number.isFinite(minContextHeader) && minContextHeader > 0 ? minContextHeader : undefined,
      privateMode: req.headers['x-fr-private'] === '1' || deps.privateMode?.() === true,
      signal: controller.signal
    }
    const id = `chatcmpl-fr${randomBytes(12).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    const events = deps.route(body, opts)

    // ---- non-streaming: aggregate ----
    if (!body.stream) {
      const agg = new CompletionAggregator()
      let model = ''
      for await (const ev of events) {
        if (ev.type === 'start') model = ev.model
        else if (ev.type === 'chunk') agg.add(ev.chunk)
        else if (ev.type === 'error') {
          void reply.header('x-fr-attempts', attemptsHeader(ev.attempts))
          return openAiError(reply, ev.status, ev.error.message, ev.error.type, ev.error.code)
        } else if (ev.type === 'done') {
          void reply.headers({ 'x-fr-provider': ev.provider, 'x-fr-model': ev.model, 'x-fr-attempts': attemptsHeader(ev.attempts) })
          return reply.send(agg.result({ id, created, model: model || ev.model, usage: openAiUsage(ev.usage) }))
        }
      }
      return openAiError(reply, 499, 'Request cancelled', 'cancelled', 'cancelled')
    }

    // ---- streaming: headers are sent only once a model has actually started answering ----
    const includeUsage = body.stream_options?.include_usage === true
    const write = (data: unknown): void => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    }
    let started = false
    let model = ''
    for await (const ev of events) {
      if (ev.type === 'error' && !started) {
        void reply.header('x-fr-attempts', attemptsHeader(ev.attempts))
        return openAiError(reply, ev.status, ev.error.message, ev.error.type, ev.error.code)
      }
      if (ev.type === 'start') {
        started = true
        model = ev.model
        reply.hijack()
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-fr-provider': ev.provider,
          'x-fr-model': ev.model,
          'x-fr-attempts': attemptsHeader(ev.attempts)
        })
        continue
      }
      if (ev.type === 'chunk') {
        const { usage: _u, ...rest } = ev.chunk as ChatChunk
        write({ ...rest, id, object: 'chat.completion.chunk', created, model })
      } else if (ev.type === 'done') {
        if (includeUsage) write({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: openAiUsage(ev.usage) })
        reply.raw.write('data: [DONE]\n\n')
        reply.raw.end()
        return
      } else if (ev.type === 'error') {
        // Mid-stream failure (PRD §6): an error event, then the stream ends. No silent retry.
        write({ error: { message: redact(ev.error.message), type: ev.error.type, code: ev.error.code, param: null } })
        reply.raw.end()
        return
      }
    }
    if (started && !reply.raw.writableEnded) reply.raw.end()
    else if (!started) return openAiError(reply, 499, 'Request cancelled', 'cancelled', 'cancelled')
  })

  app.setNotFoundHandler((req, reply) => openAiError(reply, 404, `Unknown endpoint ${req.method} ${req.url}`, 'invalid_request_error', 'not_found'))
  app.setErrorHandler((err: { statusCode?: number; message: string }, _req, reply) =>
    openAiError(reply, err.statusCode && err.statusCode < 500 ? err.statusCode : 500, err.message, 'server_error', 'internal_error')
  )
  return app
}

/** Starts the gateway on 127.0.0.1 only (never 0.0.0.0). */
export async function startGateway(deps: GatewayDeps, port: number): Promise<FastifyInstance> {
  const app = buildGateway(deps)
  await app.listen({ host: '127.0.0.1', port })
  return app
}

export function boundPort(app: FastifyInstance): number {
  return (app.server.address() as AddressInfo).port
}
