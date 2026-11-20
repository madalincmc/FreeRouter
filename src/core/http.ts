/**
 * Minimal fetch surface used by core. In the app this is the global (undici) fetch;
 * tests pass a scripted fake. Keeping it narrow keeps core free of Electron/Node HTTP details.
 */
export interface HttpResponse {
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export interface HttpRequestInit {
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
}

export type FetchLike = (url: string, init: HttpRequestInit) => Promise<HttpResponse>

/** Runs `fn` with an AbortSignal that fires after `timeoutMs`. */
export async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<{ value: T; timedOut: false } | { error: unknown; timedOut: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return { value: await fn(controller.signal), timedOut: false }
  } catch (error) {
    return { error, timedOut: controller.signal.aborted }
  } finally {
    clearTimeout(timer)
  }
}

/** Reads a dotted path (`a.b.c`) from a JSON value. An empty path returns the value itself. */
export function getPath(obj: unknown, path: string): unknown {
  if (path === '') return obj
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
