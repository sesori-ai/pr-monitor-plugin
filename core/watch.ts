// Per-PR watch state machine. Rolling debounce (no cap): any activity resets
// the quiet timer; when the quiet window elapses, a report is generated fresh
// from the latest snapshot and delivered to the owning session. A due report
// is held while the CI suite is running, bounded by maxCiWaitMinutes, then
// force-flushed naming unfinished checks. One event overrides both timers: a
// newly failing check flushes on the spot (see maybeAutoFlush).

import { detectActivity, hasNewCiFailure } from "./activity"
import type { MonitorConfig } from "./config"
import { ciPhase, PollError, type PrSnapshot } from "./github"
import { buildReport } from "./report"
import { targetKey, targetUrl, type Target } from "./target"

export type WatchDeps = {
  now: () => number
  fetchSnapshot: () => Promise<PrSnapshot>
  deliver: (report: string) => Promise<void>
  log: (message: string) => void
  onStopped: () => void
}

const MAX_CONSECUTIVE_FAILURES = 10

export class PrWatch {
  readonly target: Target
  readonly sessionID: string
  readonly config: MonitorConfig
  private readonly deps: WatchDeps
  private readonly startedAt: number

  private snapshot: PrSnapshot | undefined
  // Last MERGEABLE/CONFLICTING value seen, carried across transient UNKNOWN
  // polls so a MERGEABLE -> UNKNOWN -> CONFLICTING settle is still detected.
  private lastDefiniteMergeable: "MERGEABLE" | "CONFLICTING" | undefined
  private dirty = false
  private lastActivityAt = 0
  private lastFlushAt: number
  private holdStartedAt: number | undefined
  // Set when a check went red: the next flush check ignores the debounce window
  // and the CI hold.
  private urgent = false
  // Head SHA whose CI failure already triggered an instant flush. Caps the
  // instant path at one report per commit, so a matrix whose jobs go red one by
  // one cannot wake the session once per job; the stragglers ride along with the
  // debounced suite-conclusion report instead.
  private urgentFlushedSha: string | undefined
  private consecutiveFailures = 0
  private deliveryFailures = 0
  private fetchStartedAt: number | undefined
  private snapshotAt: number | undefined
  private stopped = false
  // Serializes tick()/manualFlush(): their fetch -> apply -> flush -> deliver
  // sequences share snapshot/baseline state, and interleaved awaits could
  // overwrite a newer snapshot with an older fetch or restore a stale baseline
  // (duplicate or stale reports). Ticks skip instead of queueing while an op is
  // pending — the interval fires again soon anyway; manual flushes queue.
  private opQueue: Promise<unknown> = Promise.resolve()
  private pendingOps = 0

  constructor(input: { target: Target; sessionID: string; config: MonitorConfig; deps: WatchDeps; initial: PrSnapshot }) {
    this.target = input.target
    this.sessionID = input.sessionID
    this.config = input.config
    this.deps = input.deps
    this.startedAt = input.deps.now()
    this.lastFlushAt = this.startedAt
    this.snapshot = input.initial
    this.rememberDefiniteMergeable(input.initial)
  }

  private rememberDefiniteMergeable(snapshot: PrSnapshot): void {
    if (snapshot.mergeable !== "UNKNOWN") this.lastDefiniteMergeable = snapshot.mergeable
  }

  get isStopped(): boolean {
    return this.stopped
  }

  statusLine(): string {
    const now = this.deps.now()
    const phase = this.holdStartedAt !== undefined ? "ci-hold" : "watching"
    const baselineAge = Math.round((now - this.lastFlushAt) / 60_000)
    const failures = this.consecutiveFailures > 0 ? `, ${this.consecutiveFailures} consecutive poll failures` : ""
    return `${targetKey(this.target)} — ${phase}, ${this.dirty ? "activity buffered" : "quiet"}, baseline ${baselineAge}m ago${failures}`
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.pendingOps += 1
    const run = this.opQueue.then(task)
    this.opQueue = run.then(
      () => {
        this.pendingOps -= 1
      },
      () => {
        this.pendingOps -= 1
      },
    )
    return run
  }

  /** Periodic poll; never throws. Skipped while a poll or flush is in flight. */
  async tick(): Promise<void> {
    if (this.stopped || this.pendingOps > 0) return
    try {
      await this.runExclusive(() => this.pollOnce())
    } catch (error) {
      this.deps.log(`unexpected tick error for ${targetKey(this.target)}: ${error}`)
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped) return
    let next: PrSnapshot
    try {
      this.fetchStartedAt = this.deps.now()
      next = await this.deps.fetchSnapshot()
    } catch (error) {
      if (!this.stopped) this.handlePollFailure(error)
      return
    }
    // A stop() that landed during the await must win: a stopped monitor may
    // not apply the snapshot or deliver anything.
    if (this.stopped) return
    this.consecutiveFailures = 0
    this.snapshotAt = this.fetchStartedAt
    if (this.snapshot !== undefined) {
      if (detectActivity(this.snapshot, next, this.lastDefiniteMergeable)) {
        this.dirty = true
        this.lastActivityAt = this.deps.now()
        this.holdStartedAt = undefined
      }
      // A red check is actionable on its own, so it does not wait for the quiet
      // window (which unrelated comment activity keeps resetting) nor for the
      // rest of the suite. Marks dirty itself: a mid-suite failure is not
      // `detectActivity`, so on the running-suite path nothing else would.
      if (
        this.config.flushOnCiFailure &&
        next.state === "OPEN" &&
        this.urgentFlushedSha !== next.headSha &&
        hasNewCiFailure(this.snapshot, next)
      ) {
        this.dirty = true
        this.urgent = true
        this.urgentFlushedSha = next.headSha
        this.holdStartedAt = undefined
      }
    }
    this.snapshot = next
    this.rememberDefiniteMergeable(next)
    await this.maybeAutoFlush()
  }

  /**
   * Initial status delivered right after the watch starts, so the owning
   * session sees where it is starting from and can address anything already
   * outstanding on the PR. Reports against a zero baseline so every existing
   * comment counts as "new", then advances the baseline to the initial
   * snapshot so periodic flushes only surface genuinely newer activity.
   * A delivery failure here is logged, not fatal to the watch; the returned
   * promise never rejects. Callers that need the announcement spooled before
   * they return (the Claude Code shell) can await it; fire-and-forget callers
   * use `void`.
   */
  async announceInitial(): Promise<void> {
    if (this.stopped || this.snapshot === undefined) return
    const report = buildReport(this.target, this.snapshot, { baselineMs: 0 })
    this.lastFlushAt = this.snapshotAt ?? this.startedAt
    await this.deliverOrLog(report)
  }

  /**
   * Manual flush: always re-fetches and always returns a full report.
   * Serialized with polling and concurrent flushes so overlapping fetches
   * cannot land out of order.
   */
  async manualFlush(): Promise<string> {
    return await this.runExclusive(() => this.flushOnce())
  }

  private async flushOnce(): Promise<string> {
    try {
      this.fetchStartedAt = this.deps.now()
      this.snapshot = await this.deps.fetchSnapshot()
      this.rememberDefiniteMergeable(this.snapshot)
      this.consecutiveFailures = 0
      this.snapshotAt = this.fetchStartedAt
    } catch (error) {
      if (this.snapshot === undefined) return `${targetKey(this.target)}: flush failed — ${(error as Error).message}`
      // Refresh failed: report from the stale snapshot WITHOUT advancing the
      // baseline, so activity newer than that snapshot is not silently skipped.
      const report = buildReport(this.target, this.snapshot, { baselineMs: this.lastFlushAt })
      return `${report}\n(note: refresh failed — ${(error as Error).message}; data is from the previous poll; baseline NOT reset)`
    }
    const report = this.flush(undefined)
    this.stopIfTerminal()
    return report
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.deps.onStopped()
  }

  async stopWithNotice(reason: string): Promise<void> {
    if (this.stopped) return
    this.stop()
    await this.deliverOrLog(`[PR Monitor] [${targetKey(this.target)}](${targetUrl(this.target)}) — ${reason}`)
  }

  private handlePollFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof PollError && error.notFound) {
      void this.deliverOrLog(`[PR Monitor] [${targetKey(this.target)}](${targetUrl(this.target)}) — Monitor stopped: PR not found (deleted or inaccessible). Last error: ${message}`)
      this.stop()
      return
    }
    this.consecutiveFailures += 1
    this.deps.log(`poll failed for ${targetKey(this.target)} (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${message}`)
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      void this.deliverOrLog(`[PR Monitor] [${targetKey(this.target)}](${targetUrl(this.target)}) — Monitor stopped: ${MAX_CONSECUTIVE_FAILURES} consecutive poll failures. Last error: ${message}`)
      this.stop()
    }
  }

  /**
   * Delivery is awaited here rather than fire-and-forget, which keeps it inside
   * the caller's `runExclusive` op. The rollback below restores exactly the
   * state a *later* flush would have advanced, so an overlapping delivery that
   * rejected late could roll a newer report's baseline back and — with `urgent`
   * restored — fire a duplicate report immediately. Serializing keeps every
   * rollback about the flush it belongs to. The cost is that ticks skip while a
   * report is in flight, which is the right behavior anyway: there is nothing
   * useful to do with a fresher snapshot while the previous report is stuck.
   */
  private async maybeAutoFlush(): Promise<void> {
    if (!this.dirty || this.snapshot === undefined) return
    const now = this.deps.now()
    let forcedHoldMinutes: number | undefined
    // Urgent (a check just went red) skips both timers: the report goes out now,
    // carrying whatever else was buffered. The CI line renders the still-running
    // suite honestly ("running (3/8 done, 1 failed so far: lint)"), so no
    // forcedHoldMinutes annotation is wanted here — nothing was held.
    if (!this.urgent) {
      if (now - this.lastActivityAt < this.config.debounceMinutes * 60_000) return
      if (ciPhase(this.snapshot) === "running" && this.snapshot.state === "OPEN") {
        if (this.holdStartedAt === undefined) this.holdStartedAt = now
        const heldMs = now - this.holdStartedAt
        if (heldMs < this.config.maxCiWaitMinutes * 60_000) return
        forcedHoldMinutes = Math.round(heldMs / 60_000)
      }
    }
    const previousFlushAt = this.lastFlushAt
    const previousHoldStartedAt = this.holdStartedAt
    const previousUrgent = this.urgent
    const report = this.flush(forcedHoldMinutes)
    try {
      await this.deps.deliver(report)
      this.deliveryFailures = 0
      this.stopIfTerminal()
    } catch (error) {
      // Delivery failed: restore the baseline, dirty flag, CI-hold timer and
      // urgency so the same activity is re-reported on a later tick without
      // restarting the maxCiWaitMinutes window — and so a failed instant CI
      // report retries instantly rather than falling back to the debounce.
      this.lastFlushAt = previousFlushAt
      this.dirty = true
      this.holdStartedAt = previousHoldStartedAt
      this.urgent = previousUrgent
      this.deliveryFailures += 1
      this.deps.log(`report delivery failed for ${targetKey(this.target)} (${this.deliveryFailures}/${MAX_CONSECUTIVE_FAILURES}), will retry: ${error}`)
      if (this.deliveryFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.deps.log(`monitor stopped for ${targetKey(this.target)}: ${MAX_CONSECUTIVE_FAILURES} consecutive delivery failures`)
        this.stop()
      }
    }
  }

  private async deliverOrLog(message: string): Promise<void> {
    try {
      await this.deps.deliver(message)
    } catch (error) {
      this.deps.log(`report delivery failed for ${targetKey(this.target)}: ${error}`)
    }
  }

  private flush(forcedHoldMinutes: number | undefined): string {
    const snapshot = this.snapshot!
    const report = buildReport(this.target, snapshot, { baselineMs: this.lastFlushAt, forcedHoldMinutes })
    this.lastFlushAt = this.snapshotAt ?? this.deps.now()
    this.dirty = false
    this.holdStartedAt = undefined
    this.urgent = false
    return report
  }

  private stopIfTerminal(): void {
    if (this.snapshot !== undefined && this.snapshot.state !== "OPEN") this.stop()
  }
}
