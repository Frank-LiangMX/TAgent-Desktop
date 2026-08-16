/**
 * Idle memory consolidation scheduler (ADR-0006)
 *
 * Phase 2.1 从 TAgent_General 移植。Desktop 通过主进程注入「是否有模型轮在运行」
 * 判定前台活跃；窗口处于前台但没有运行任务时，允许静默整理积压记忆。
 *
 * Replaces the old per-turn LLM calls with a single idle-triggered batch scan.
 * Uses recurring setTimeout (not setInterval): the next tick is scheduled only
 * AFTER the current scan completes, preventing overlap.
 *
 * First tick is delayed by TICK_MS — no immediate startup request.
 * Serial: general then ta. The global lease in ConsolidationService itself
 * enforces single-concurrent across modes.
 *
 * The class IdleConsolidationScheduler accepts injected dependencies so tests
 * can provide fake timers and mock services without vi.mock.  The module-level
 * singleton functions (startIdleConsolidationScheduler, stopIdleConsolidation-
 * Scheduler, isSchedulerRunning) retain the same production API.
 *
 * Rollout flag:
 *   TAGENT_IDLE_MEMORY_CONSOLIDATION='1' → force on
 *   TAGENT_IDLE_MEMORY_CONSOLIDATION='0' → force off
 *   (unset) → ON（开发与打包版一致）
 */

export const TICK_MS = 60_000

/** 主进程在 SessionService 就绪后注入；默认无活跃任务，避免永久阻塞整理。 */
let foregroundActivityProbe: () => boolean = () => false

export function setMemoryForegroundActivityProbe(probe: () => boolean): void {
  foregroundActivityProbe = probe
}

// ---------------------------------------------------------------------------
// Minimal wire-format — the scheduler only needs runIfEligible from the
// ConsolidationService.  All other details (foreground gating, leases, dirty
// tracking) live inside the service itself.
// ---------------------------------------------------------------------------

export interface ConsolidationServiceLike {
  runIfEligible(mode: string): Promise<unknown>
}

export interface IdleSchedulerDeps {
  createService: () => Promise<ConsolidationServiceLike>
  setTimeout: (cb: () => void, ms: number) => number
  clearTimeout: (id: number) => void
}

// ---------------------------------------------------------------------------
// DI-friendly class
// ---------------------------------------------------------------------------

export class IdleConsolidationScheduler {
  private timerId: number | null = null
  private started = false
  private deps: IdleSchedulerDeps
  private tickMs: number

  constructor(deps: IdleSchedulerDeps, tickMs = TICK_MS) {
    this.deps = deps
    this.tickMs = tickMs
  }

  // ---- read-only state queries -------------------------------------------

  isRunning(): boolean {
    return this.started
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    try {
      const service = await this.deps.createService()
      // Guard: stop may have been called while createService was pending
      if (!this.started) return

      this.scheduleNextTick(service)
    } catch (err) {
      console.error('[空闲整理] 创建 ConsolidationService 失败:', err)
      this.started = false
    }
  }

  stop(): void {
    if (this.timerId !== null) {
      this.deps.clearTimeout(this.timerId)
      this.timerId = null
    }
    this.started = false
  }

  // ---- internal -----------------------------------------------------------

  private scheduleNextTick(service: ConsolidationServiceLike): void {
    this.timerId = this.deps.setTimeout(async () => {
      this.timerId = null
      if (!this.started) return
      await this.runScan(service)
      // Recurse: schedule next tick only after this scan finishes
      if (this.started) {
        this.scheduleNextTick(service)
      }
    }, this.tickMs)
  }

  private async runScan(service: ConsolidationServiceLike): Promise<void> {
    try {
      await service.runIfEligible('general')
    } catch (err) {
      console.error('[空闲整理] general 扫描异常:', err)
    }
    try {
      await service.runIfEligible('ta')
    } catch (err) {
      console.error('[空闲整理] ta 扫描异常:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Production singleton — wired to the real ConsolidationService.
// No test file imports or mocks this path.
// ---------------------------------------------------------------------------

const defaultScheduler = new IdleConsolidationScheduler({
  createService: async () => {
    const { buildDefaultDeps, ConsolidationService } =
      await import('./memory-consolidation-service')
    const deps = await buildDefaultDeps()
    deps.isForegroundActive = () => foregroundActivityProbe()
    return new ConsolidationService(deps)
  },
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
})

// ---- module-level API (unchanged surface for callers) ---------------------

export function startIdleConsolidationScheduler(): Promise<void> {
  return defaultScheduler.start()
}

export function stopIdleConsolidationScheduler(): void {
  defaultScheduler.stop()
}

export function isSchedulerRunning(): boolean {
  return defaultScheduler.isRunning()
}

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

export function resolveIdleConsolidationFlag(isPackaged: boolean): boolean {
  const env = process.env.TAGENT_IDLE_MEMORY_CONSOLIDATION
  if (env === '1') return true
  if (env === '0') return false
  void isPackaged
  return true
}
