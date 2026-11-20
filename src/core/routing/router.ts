import type { ModelState, ModelView, ProviderView } from '@shared/ipc'
import type { FetchLike, HttpResponse } from '../http'
import { errorMessage } from '../keys/validate'
import type { ProviderProfile } from '../providers/catalog'
import { redact } from '../security/redact'
import { rank, RoutingError, type Candidate } from './candidates'
import { classifyHttpFailure, stateForFailure, type Failure } from './errors'
import type { HealthTracker } from './health'
import { parseModelField, requestNeeds, UnknownModelError, type RequestNeeds } from './intent'
import type { QuotaTracker } from './quota'
import type { RequestLogEntry } from './log'
import { buildUpstreamBody, ChunkNormalizer } from './normalize'
import { readSse } from './sse'
import type { StickyStore } from './sticky'
import {
  DEFAULT_ROUTER_CONFIG,
  type Attempt,
  type ChatChunk,
  type ChatRequest,
  type RouteOptions,
  type RouterConfig,
  type RouterEvent
} from './types'

export interface RouterDeps {
  snapshot(): { models: ModelView[]; providers: ProviderView[] }
  profile(providerId: string): ProviderProfile | undefined
  revealKey(keyId: string): Promise<string>
  markKeyInvalid(keyId: string): void
  recordModelOutcome(
    modelId: string,
    o: { latencyMs?: number; state?: ModelState; cooldownUntil?: number | null; error?: string | null }
  ): void
  chains(name: string): string[] | undefined
  log(entry: RequestLogEntry): void
  quota: QuotaTracker
  health: HealthTracker
  sticky?: StickyStore
  fetch: FetchLike
  now?: () => number
  config?: () => RouterConfig
}

type AttemptResult =
  | { kind: 'failed'; failure: Failure }
  | { kind: 'cancelled' }
  | { kind: 'finished' } // success or mid-stream error; events already yielded

/** A chunk that proves the model is actually producing output (not just a role header). */
function isMeaningful(c: ChatChunk): boolean {
  return c.choices?.some((ch) => {
    const d = ch.delta ?? {}
    return (
      (typeof d.content === 'string' && d.content.length > 0) ||
      (typeof d.reasoning === 'string' && d.reasoning.length > 0) ||
      (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) ||
      !!ch.finish_reason
    )
  })
}

function errorEvent(status: number, code: string, message: string, attempts: Attempt[], midStream = false): RouterEvent {
  return { type: 'error', midStream, status, error: { message, type: midStream ? 'upstream_error' : 'router_error', code }, attempts }
}

/** Converts a non-streamed completion into chunks so callers see one shape. */
function completionToChunks(json: unknown): ChatChunk[] {
  const c = json as {
    id?: string
    model?: string
    created?: number
    choices?: Array<{ index?: number; message?: Record<string, unknown>; finish_reason?: string | null }>
    usage?: ChatChunk['usage']
  }
  if (!Array.isArray(c.choices)) return []
  return [
    {
      id: c.id,
      object: 'chat.completion.chunk',
      created: c.created,
      model: c.model,
      choices: c.choices.map((ch, i) => ({
        index: ch.index ?? i,
        delta: { role: 'assistant', ...(ch.message ?? {}) },
        finish_reason: ch.finish_reason ?? 'stop'
      })),
      usage: c.usage ?? null
    }
  ]
}

/**
 * The orchestrator (PRD §6): ranks candidates and walks them until one starts answering.
 * Failures before the first token fail over invisibly; after it, the stream ends with an error.
 */
export class Router {
  private readonly rotation = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly d: RouterDeps) {
    this.now = d.now ?? Date.now
  }

  private get cfg(): RouterConfig {
    return this.d.config?.() ?? DEFAULT_ROUTER_CONFIG
  }

  async *route(req: ChatRequest, opts: RouteOptions): AsyncGenerator<RouterEvent> {
    const started = this.now()
    const cfg = this.cfg
    const attempts: Attempt[] = []
    const { models, providers } = this.d.snapshot()
    let needs: RequestNeeds | undefined
    const log = (status: string, extra: Partial<RequestLogEntry> = {}): void =>
      this.d.log({
        ts: started,
        source: opts.source,
        clientUa: opts.clientUa ?? null,
        requestedModel: req.model ?? 'auto',
        chosenModel: null,
        attempts,
        status,
        latencyMs: this.now() - started,
        ttftMs: null,
        promptTokens: needs?.promptTokens ?? null,
        completionTokens: null,
        error: null,
        ...extra
      })

    let candidates: Candidate[]
    let stickyKey: string | undefined
    try {
      const strategy = parseModelField(req.model, new Set(providers.map((p) => p.id)))
      needs = requestNeeds(req, strategy.kind === 'auto' ? strategy.profile : null, cfg)
      // Stickiness applies to automatic routing only; pinned and chains are already explicit.
      stickyKey = strategy.kind === 'auto' && cfg.stickiness && this.d.sticky ? opts.stickyKey : undefined
      const ranking = rank({
        strategy,
        needs,
        models,
        providers,
        chains: this.d.chains,
        quota: this.d.quota,
        health: this.d.health,
        cfg,
        opts,
        rotation: this.rotation,
        excludeModels: opts.excludeModels?.length ? new Set(opts.excludeModels) : undefined,
        preferModel: stickyKey ? this.d.sticky!.get(stickyKey) : undefined
      })
      candidates = ranking.candidates
      if (candidates.length === 0) {
        const reasons = [...new Set(ranking.excluded.map((e) => e.reason))].slice(0, 4).join('; ')
        const msg =
          models.length === 0
            ? 'No models in the registry yet. Add a provider key so its model list can sync.'
            : `No free model can take this request right now${reasons ? ` (${reasons})` : ''}. Add provider keys or wait for cooldowns.`
        log('no_candidates', { error: msg })
        yield errorEvent(503, 'no_models_available', msg, attempts)
        return
      }
    } catch (err) {
      const status = err instanceof RoutingError ? err.status : err instanceof UnknownModelError ? 404 : 400
      const code = err instanceof RoutingError ? err.code : err instanceof UnknownModelError ? 'model_not_found' : 'invalid_request'
      const msg = redact((err as Error).message)
      log('rejected', { error: msg })
      yield errorEvent(status, code, msg, attempts)
      return
    }

    const deadKeys = new Set<string>()
    for (const c of candidates) {
      if (opts.signal?.aborted) break
      if (deadKeys.has(c.key.id)) {
        attempts.push({ provider: c.provider.id, model: c.model.id, outcome: 'skipped', message: 'key rejected earlier', ms: 0 })
        continue
      }
      const result = yield* this.attempt(c, req, needs!, { ...opts, stickyKey }, attempts, started, log)
      if (result.kind === 'finished') return
      if (result.kind === 'cancelled') break
      if (result.failure.kind === 'auth') deadKeys.add(c.key.id)
    }

    if (opts.signal?.aborted) {
      log('cancelled')
      return
    }
    const last = attempts.filter((a) => a.outcome === 'failed').at(-1)
    const msg = `All ${attempts.length} candidate models failed${last ? `; last error: ${last.message ?? last.failure}` : ''}`
    log('failed', { error: msg })
    // 429 when everything was rate-limited, so clients' retry/backoff logic kicks in.
    const allLimited = attempts.every((a) => a.failure === 'rate_limited' || a.failure === 'quota_exhausted' || a.outcome === 'skipped')
    yield errorEvent(allLimited ? 429 : 502, allLimited ? 'rate_limited' : 'all_candidates_failed', msg, attempts)
  }

  private async *attempt(
    c: Candidate,
    req: ChatRequest,
    needs: RequestNeeds,
    opts: RouteOptions,
    attempts: Attempt[],
    requestStarted: number,
    log: (status: string, extra?: Partial<RequestLogEntry>) => void
  ): AsyncGenerator<RouterEvent, AttemptResult> {
    const cfg = this.cfg
    const profile = this.d.profile(c.provider.id)
    const t0 = this.now()
    const fail = (failure: Failure): AttemptResult => {
      this.applyFailure(c, failure)
      attempts.push({
        provider: c.provider.id,
        model: c.model.id,
        outcome: 'failed',
        failure: failure.kind,
        status: failure.status,
        message: redact(failure.message).slice(0, 200),
        ms: this.now() - t0
      })
      return { kind: 'failed', failure }
    }
    if (!profile) return fail({ kind: 'bad_request', message: 'provider profile missing' })

    const key = await this.d.revealKey(c.key.id)
    if (c.provider.keyRotation) this.rotation.set(c.provider.id, (this.rotation.get(c.provider.id) ?? 0) + 1)
    this.d.quota.recordRequest(c.counterKey, needs.promptTokens)

    const controller = new AbortController()
    let abortReason: 'ttft' | 'total' | 'client' | null = null
    const abort = (why: 'ttft' | 'total' | 'client'): void => {
      abortReason ??= why
      controller.abort()
    }
    const onClientAbort = (): void => abort('client')
    opts.signal?.addEventListener('abort', onClientAbort)
    const ttftTimer = setTimeout(() => abort('ttft'), cfg.ttftTimeoutMs)
    const totalTimer = setTimeout(() => abort('total'), cfg.totalTimeoutMs)
    const cleanup = (): void => {
      clearTimeout(ttftTimer)
      clearTimeout(totalTimer)
      opts.signal?.removeEventListener('abort', onClientAbort)
    }
    const timeoutFailure = (): Failure => ({
      kind: 'timeout',
      message: abortReason === 'ttft' ? `no first token within ${cfg.ttftTimeoutMs} ms` : `exceeded ${cfg.totalTimeoutMs} ms`
    })

    // Routing fields replaced and provider-rejected parameters stripped (profile data).
    const body = JSON.stringify(buildUpstreamBody(req, profile, c.model.modelId))
    const normalizer = new ChunkNormalizer()

    let res: HttpResponse
    try {
      res = await this.d.fetch(`${profile.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          Authorization: `Bearer ${key}`
        },
        body,
        signal: controller.signal
      })
    } catch (err) {
      cleanup()
      if (abortReason === 'client') return { kind: 'cancelled' }
      if (abortReason) return fail(timeoutFailure())
      return fail({ kind: 'network', message: `network error: ${(err as Error).message ?? err}` })
    }

    this.d.quota.recordHeaders(c.counterKey, res.headers)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      cleanup()
      const failure = classifyHttpFailure(res.status, res.headers, text, this.now())
      failure.message = errorMessage(text) || `HTTP ${res.status}`
      return fail(failure)
    }

    // ---- 200: stream (or a plain JSON completion from a provider that ignored stream:true) ----
    let started = false
    let ttftMs = 0
    let usage: ChatChunk['usage'] = null
    let outChars = 0
    const buffered: ChatChunk[] = []

    const commit = function* (this: Router): Generator<RouterEvent> {
      started = true
      ttftMs = this.now() - t0
      clearTimeout(ttftTimer)
      attempts.push({ provider: c.provider.id, model: c.model.id, outcome: 'ok', ms: ttftMs })
      yield { type: 'start', provider: c.provider.id, model: c.model.id, modelId: c.model.modelId, attempts: [...attempts] }
    }.bind(this)

    const track = (chunk: ChatChunk): void => {
      if (chunk.usage) usage = chunk.usage
      for (const ch of chunk.choices ?? []) {
        outChars += (ch.delta?.content?.length ?? 0) + (ch.delta?.reasoning?.length ?? 0)
        if (ch.delta?.tool_calls) outChars += JSON.stringify(ch.delta.tool_calls).length
      }
    }

    try {
      const contentType = res.headers.get('content-type') ?? ''
      const source: AsyncIterable<string> =
        contentType.includes('application/json') || !res.body
          ? (async function* () {
              const json: unknown = JSON.parse(await res.text())
              for (const chunk of completionToChunks(json)) yield JSON.stringify(chunk)
            })()
          : readSse(res.body, controller.signal)

      for await (const data of source) {
        let chunk: ChatChunk & { error?: { message?: string; code?: number | string } }
        try {
          chunk = JSON.parse(data)
        } catch {
          continue // keep-alive noise
        }
        if (chunk.error) {
          // Some providers (OpenRouter) report upstream errors inside a 200 stream.
          const status = typeof chunk.error.code === 'number' ? chunk.error.code : 502
          const message = chunk.error.message ?? 'upstream error'
          if (!started) {
            cleanup()
            const failure = classifyHttpFailure(status, res.headers, JSON.stringify(chunk), this.now())
            failure.message = message
            return fail(failure)
          }
          throw new Error(message)
        }
        if (!Array.isArray(chunk.choices)) continue
        normalizer.normalize(chunk)
        track(chunk)
        if (!started) {
          buffered.push(chunk)
          if (!isMeaningful(chunk)) continue
          yield* commit()
          for (const b of buffered.splice(0)) yield { type: 'chunk', chunk: b }
          continue
        }
        yield { type: 'chunk', chunk }
      }
    } catch (err) {
      cleanup()
      if (abortReason === 'client') {
        log('cancelled', { chosenModel: started ? c.model.id : null })
        return { kind: 'cancelled' }
      }
      const failure: Failure = abortReason ? timeoutFailure() : { kind: 'network', message: `stream broke: ${(err as Error).message ?? err}` }
      if (!started) return fail(failure)
      return yield* this.midStreamError(c, failure, attempts, t0, ttftMs, log)
    }
    cleanup()

    if (!started) return fail({ kind: 'server', message: 'empty response (no tokens)' })

    // ---- success ----
    const latencyMs = this.now() - t0
    const u = usage as ChatChunk['usage']
    const promptTokens = u?.prompt_tokens ?? needs.promptTokens
    const completionTokens = u?.completion_tokens ?? Math.ceil(outChars / 4)
    this.d.quota.recordTokens(c.counterKey, completionTokens)
    this.d.health.record(c.model.id, true)
    this.d.health.success(c.model.id)
    this.d.recordModelOutcome(c.model.id, { latencyMs: ttftMs, state: 'healthy', cooldownUntil: null, error: null })
    if (opts.stickyKey) this.d.sticky?.set(opts.stickyKey, c.model.id)
    log('ok', {
      chosenModel: c.model.id,
      ttftMs,
      promptTokens,
      completionTokens,
      latencyMs: this.now() - requestStarted
    })
    yield {
      type: 'done',
      provider: c.provider.id,
      model: c.model.id,
      attempts: [...attempts],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        estimated: !u?.completion_tokens
      },
      latencyMs,
      ttftMs
    }
    return { kind: 'finished' }
  }

  /** PRD §6: after tokens were sent, never retry silently – end the stream with an error. */
  private *midStreamError(
    c: Candidate,
    failure: Failure,
    attempts: Attempt[],
    t0: number,
    ttftMs: number,
    log: (status: string, extra?: Partial<RequestLogEntry>) => void
  ): Generator<RouterEvent, AttemptResult> {
    this.applyFailure(c, failure)
    const last = attempts.at(-1)
    if (last && last.model === c.model.id) {
      last.outcome = 'mid_stream_error'
      last.failure = failure.kind
      last.message = redact(failure.message).slice(0, 200)
      last.ms = this.now() - t0
    }
    const msg = `The response from ${c.model.id} was interrupted: ${redact(failure.message)}`
    log('mid_stream_error', { chosenModel: c.model.id, ttftMs, error: msg })
    yield errorEvent(502, 'stream_interrupted', msg, attempts, true)
    return { kind: 'finished' }
  }

  /** Turns a failure into model/key state (PRD §6 "Classify failure and move on"). */
  private applyFailure(c: Candidate, f: Failure): void {
    const error = redact(f.message).slice(0, 300)
    switch (f.kind) {
      case 'auth':
        this.d.markKeyInvalid(c.key.id)
        return
      case 'context':
      case 'bad_request':
        // Request-specific: this model is just skipped for this request.
        return
      case 'server':
      case 'timeout':
      case 'network':
      case 'not_found': {
        this.d.health.record(c.model.id, false)
        const streak = this.d.health.serverFailure(c.model.id)
        if (streak >= this.cfg.degradedStreak) {
          this.d.recordModelOutcome(c.model.id, {
            state: 'cooling_down',
            cooldownUntil: this.now() + this.cfg.degradedCooldownMs,
            error
          })
        } else {
          this.d.recordModelOutcome(c.model.id, { ...stateForFailure(f), error })
        }
        return
      }
      default:
        // Rate limits and quotas: cooldown until the reset, not counted against reliability.
        this.d.recordModelOutcome(c.model.id, { ...stateForFailure(f), error })
    }
  }
}
