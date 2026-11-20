const WINDOW = 50

/**
 * In-memory call history per model: reliability over the last 50 calls (PRD §6) and the
 * consecutive-failure streak that turns "degraded" into a 5-minute cooldown.
 */
export class HealthTracker {
  private readonly outcomes = new Map<string, boolean[]>()
  private readonly streaks = new Map<string, number>()

  record(modelId: string, ok: boolean): void {
    const list = [...(this.outcomes.get(modelId) ?? []), ok].slice(-WINDOW)
    this.outcomes.set(modelId, list)
  }

  /** Server/timeout failures in a row; reset by any success. Returns the new streak. */
  serverFailure(modelId: string): number {
    const n = (this.streaks.get(modelId) ?? 0) + 1
    this.streaks.set(modelId, n)
    return n
  }

  success(modelId: string): void {
    this.streaks.set(modelId, 0)
  }

  /**
   * Success rate with a weak prior (≈90% from 5 virtual calls), so a single failure on a new
   * model doesn't crater it and an unknown model isn't scored as perfect.
   */
  reliability(modelId: string): number {
    const list = this.outcomes.get(modelId) ?? []
    const ok = list.filter(Boolean).length
    return (ok + 4.5) / (list.length + 5)
  }
}
