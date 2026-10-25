// Session-scoped application runtime shared by host adapters. It owns watch
// deduplication, GitHub identity, timers, common actions, and readiness mutations;
// adapters own transport, lifecycle policy, and truthful host wording.

import type { MonitorConfig } from "../core/config"
import { fetchPrSnapshot, type GhRunner, type PrSnapshot } from "../core/github"
import { addReadyLabel, removeReadyLabel } from "../core/label"
import {
  AutoMergeHeadChangedError,
  autoMergeFailureText,
  type AutoMergePullRequest,
  getAutoMergePullRequest,
  squashMergePullRequest,
} from "../core/merge"
import { hasReadyLabel, withReadyLabel } from "../core/readiness"
import { AUTO_MERGE_GUIDANCE } from "../core/report"
import { parseTarget, targetKey, targetRegistryKey, type Target } from "../core/target"
import { type AutoMergeDeps, PrWatch } from "../core/watch"
import { MonitorAction } from "./tool"

export enum InitialAnnouncementMode {
  background = "background",
  awaitDelivery = "await_delivery",
}

export enum StopNoticeChannel {
  normal = "normal",
  persistent = "persistent",
}

export enum InitialAnnouncementState {
  disabled = "disabled",
  pending = "pending",
  delivered = "delivered",
  retrying = "retrying",
}

export enum WatchChangeType {
  started = "started",
  stopped = "stopped",
}

export type ReportChannel = {
  deliver: (input: { report: string }) => Promise<void>
  persist?: (input: { report: string }) => Promise<void>
}

export type WatchView<TConfig extends MonitorConfig> = {
  target: Target
  config: TConfig
  statusLine: string
}

export type StartDetails<TConfig extends MonitorConfig> = {
  target: Target
  config: TConfig
  announcement: InitialAnnouncementState
}

export type ReadyDetails = {
  target: Target
  ready: boolean
  watched: boolean
}

export type MonitorActionResult<TConfig extends MonitorConfig> = {
  text: string
  start?: StartDetails<TConfig>
  ready?: ReadyDetails
}

type WatchEntry<TConfig extends MonitorConfig> = {
  watch: PrWatch
  timer: unknown
  config: TConfig
  channel: ReportChannel
}

type MonitorSessionDeps<TConfig extends MonitorConfig> = {
  runGh: GhRunner
  loadConfig?: () => Promise<TConfig>
  log: (message: string) => void
  now?: () => number
  schedule?: (input: { callback: () => void; intervalMs: number }) => unknown
  cancel?: (input: { timer: unknown }) => void
  onWatchChanged?: (event: { type: WatchChangeType; target: Target; config: TConfig }) => void
  onTickSettled?: (event: { target: Target; config: TConfig }) => void
  onReadyChanged?: (event: { target: Target; ready: boolean; watched: boolean; config: TConfig }) => void
  statusSuffix?: (input: { target: Target; config: TConfig }) => string
}

type StartOptions<TConfig extends MonitorConfig> = {
  prepare?: () => Promise<string | undefined>
  createChannel: (input: { target: Target; config: TConfig }) => ReportChannel
  announcementMode: InitialAnnouncementMode
}

export class MonitorSession<TConfig extends MonitorConfig> {
  private readonly deps: Required<Pick<MonitorSessionDeps<TConfig>, "now" | "schedule" | "cancel">> &
    Omit<MonitorSessionDeps<TConfig>, "now" | "schedule" | "cancel">
  private readonly watches = new Map<string, WatchEntry<TConfig>>()
  // Targets with a start in flight, keyed to that start's token. A concurrent start (possibly with a different
  // autoMerge override) is refused so only the owning call performs startup label mutations. stop/stopAll drop the
  // token, so a stalled start cannot wedge the target and cannot mutate or register once it resumes.
  private readonly starting = new Map<string, symbol>()
  // In-flight startup ready-label resets by target. Cancellation and later starts await these so a canceled start's
  // DELETE cannot land after a successor has fetched its baseline.
  private readonly startupResets = new Map<string, Promise<void>>()
  // Destructive startup work happens before a watch can own the target. Keep
  // it in the session cleanup barrier so a reloaded successor cannot race it.
  private readonly startupMutations = new Set<Promise<void>>()
  // Standalone ready actions have no watch to supply a cleanup barrier. Track
  // them here so replacement sessions cannot overlap label or merge mutations.
  private readonly standaloneReadinessMutations = new Set<Promise<void>>()
  private lifecycleGeneration = 0
  private selfLogin: string | undefined
  private selfLoginPromise: Promise<string> | undefined

  constructor(deps: MonitorSessionDeps<TConfig>) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      schedule: deps.schedule ?? (({ callback, intervalMs }) => setInterval(callback, intervalMs)),
      cancel:
        deps.cancel ??
        (({ timer }) => {
          clearInterval(timer as ReturnType<typeof setInterval>)
        }),
    }
  }

  private trackStartupMutation<T>({ mutation }: { mutation: () => Promise<T> }): Promise<T> {
    const operation = Promise.resolve().then(mutation)
    const barrier = operation.then(
      () => undefined,
      () => undefined,
    )
    this.startupMutations.add(barrier)
    void barrier.then(() => this.startupMutations.delete(barrier))
    return operation
  }

  private trackStandaloneReadinessMutation<T>({ mutation }: { mutation: () => Promise<T> }): Promise<T> {
    const operation = Promise.resolve().then(mutation)
    const barrier = operation.then(
      () => undefined,
      () => undefined,
    )
    this.standaloneReadinessMutations.add(barrier)
    void barrier.then(() => this.standaloneReadinessMutations.delete(barrier))
    return operation
  }

  list(): WatchView<TConfig>[] {
    return [...this.watches.values()].map(({ watch, config }) => ({
      target: watch.target,
      config,
      statusLine: watch.statusLine(),
    }))
  }

  async execute({
    action,
    pr,
    start,
    loadConfig,
    autoMerge,
  }: {
    action: MonitorAction
    pr: string | undefined
    start?: StartOptions<TConfig>
    loadConfig?: () => Promise<TConfig>
    // User-requested override for start or set_auto_merge; wins over config and environment for that watch only.
    autoMerge?: boolean
  }): Promise<MonitorActionResult<TConfig>> {
    const actionLoadConfig =
      loadConfig ??
      this.deps.loadConfig ??
      (() => Promise.reject(new Error("this host did not provide a configuration loader")))
    switch (action) {
      case MonitorAction.start:
        if (!pr || pr === "all") {
          return { text: "action 'start' requires a single explicit pr: 'owner/repo#123' or a PR URL." }
        }
        if (start === undefined) return { text: "Cannot start monitor: this host did not provide a report channel." }
        return await this.start({ pr, options: start, loadConfig: actionLoadConfig, autoMerge })
      case MonitorAction.stop:
        if (!pr) return { text: "action 'stop' requires pr: 'owner/repo#123', a PR URL, or 'all'." }
        return await this.stop({ pr })
      case MonitorAction.flush:
        if (!pr) return { text: "action 'flush' requires pr: 'owner/repo#123', a PR URL, or 'all'." }
        return await this.flush({ pr })
      case MonitorAction.status:
        return { text: this.status() }
      case MonitorAction.markReady:
        if (!pr || pr === "all") {
          return { text: "action 'mark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL." }
        }
        return await this.changeReady({ pr, ready: true, loadConfig: actionLoadConfig })
      case MonitorAction.unmarkReady:
        if (!pr || pr === "all") {
          return { text: "action 'unmark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL." }
        }
        return await this.changeReady({ pr, ready: false, loadConfig: actionLoadConfig })
      case MonitorAction.setAutoMerge:
        if (!pr || pr === "all") {
          return { text: "action 'set_auto_merge' requires a single explicit pr: 'owner/repo#123' or a PR URL." }
        }
        if (autoMerge === undefined) return { text: "action 'set_auto_merge' requires autoMerge: true or false." }
        return await this.setAutoMerge({ pr, autoMerge })
    }
  }

  async stopAll({
    notice,
    channel = StopNoticeChannel.normal,
  }: {
    notice?: string
    channel?: StopNoticeChannel
  }): Promise<void> {
    this.lifecycleGeneration += 1
    this.starting.clear()
    const entries = [...this.watches.values()]
    const startupMutations = [...this.startupMutations]
    const standaloneReadinessMutations = [...this.standaloneReadinessMutations]
    for (const entry of entries) entry.watch.stop()
    await Promise.all([
      ...entries.map((entry) => entry.watch.waitUntilStopped()),
      ...startupMutations,
      ...standaloneReadinessMutations,
    ])
    if (notice === undefined) return

    await Promise.all(
      entries.map(async (entry) => {
        const report = entry.watch.stopNotice(notice)
        const send =
          channel === StopNoticeChannel.persistent
            ? (entry.channel.persist ?? entry.channel.deliver)
            : entry.channel.deliver
        try {
          await send({ report })
        } catch (error) {
          this.deps.log(`stop notice delivery failed for ${targetKey(entry.watch.target)}: ${error}`)
        }
      }),
    )
  }

  private async start({
    pr,
    options,
    loadConfig,
    autoMerge,
  }: {
    pr: string
    options: StartOptions<TConfig>
    loadConfig: () => Promise<TConfig>
    autoMerge: boolean | undefined
  }): Promise<MonitorActionResult<TConfig>> {
    const target = parseTarget(pr)
    if ("error" in target) return { text: target.error }
    const key = targetRegistryKey(target)
    const displayKey = targetKey(target)
    const existing = this.watches.get(key)
    if (existing) return { text: `Already monitoring ${displayKey} in this session.\n${existing.watch.statusLine()}` }
    if (this.starting.has(key)) {
      return {
        text:
          `A monitor for ${displayKey} is already starting in this session. ` +
          `If that start is stuck, call stop for ${displayKey} to cancel it.`,
      }
    }
    const token = Symbol(key)
    this.starting.set(key, token)
    const owned = () => this.starting.get(key) === token
    try {
      await this.startupResets.get(key)
      return await this.startReserved({ target, key, displayKey, options, loadConfig, autoMerge, owned })
    } finally {
      if (owned()) this.starting.delete(key)
    }
  }

  private async startReserved({
    target,
    key,
    displayKey,
    options,
    loadConfig,
    autoMerge,
    owned,
  }: {
    target: Target
    key: string
    displayKey: string
    options: StartOptions<TConfig>
    loadConfig: () => Promise<TConfig>
    autoMerge: boolean | undefined
    owned: () => boolean
  }): Promise<MonitorActionResult<TConfig>> {
    const lifecycleGeneration = this.lifecycleGeneration

    const preparationError = await options.prepare?.()
    if (preparationError !== undefined) return { text: preparationError }

    let config: TConfig
    try {
      config = await loadConfig()
      if (autoMerge !== undefined) config = { ...config, autoMerge }
    } catch (error) {
      return {
        text: `Cannot start monitor for ${displayKey}: loading configuration failed (${(error as Error).message}).`,
      }
    }
    if (config.ignoreCommentTag !== undefined && this.selfLogin === undefined) {
      try {
        this.selfLoginPromise ??= this.deps.runGh(["api", "user", "--jq", ".login"]).then((login) => login.trim())
        this.selfLogin = await this.selfLoginPromise
      } catch (error) {
        this.selfLoginPromise = undefined
        return {
          text:
            "Cannot start monitor: resolving the authenticated gh user for the reply prefix failed " +
            `(${(error as Error).message}). Run \`gh auth status\` to check.`,
        }
      }
    }

    let initial: PrSnapshot
    try {
      initial = await this.fetchSnapshot({ target, config })
    } catch (error) {
      return { text: `Cannot start monitor for ${displayKey}: ${(error as Error).message}` }
    }
    if (this.lifecycleGeneration !== lifecycleGeneration) {
      return { text: `Monitor session ended while ${displayKey} was starting; no active monitor remains.` }
    }
    if (!owned()) return { text: `Start of ${displayKey} was canceled; no active monitor remains.` }
    if (initial.state !== "OPEN") {
      return { text: `Cannot start monitor: ${displayKey} is already ${initial.state}.` }
    }

    const raced = this.watches.get(key)
    if (raced) return { text: `Already monitoring ${displayKey} in this session.\n${raced.watch.statusLine()}` }

    let startupNotice: string | undefined
    if (config.autoMerge && hasReadyLabel(initial, config.readyLabel)) {
      try {
        const reset = this.trackStartupMutation({
          mutation: () => removeReadyLabel(this.deps.runGh, target, config.readyLabel),
        })
        const drained = reset.then(
          () => undefined,
          () => undefined,
        )
        this.startupResets.set(key, drained)
        void drained.then(() => {
          if (this.startupResets.get(key) === drained) this.startupResets.delete(key)
        })
        await reset
      } catch (error) {
        return {
          text:
            `Cannot start monitor for ${displayKey}: auto-merge is enabled but the pre-existing ready label ` +
            `"${config.readyLabel}" could not be removed (${(error as Error).message}).`,
        }
      }
      initial = withReadyLabel(initial, config.readyLabel, false)
      startupNotice =
        `pre-existing ready label "${config.readyLabel}" was removed because auto-merge is enabled. ` +
        "Reassess the current head and call mark_ready once it is ready; that action squash-merges it, as intended."
      if (this.lifecycleGeneration !== lifecycleGeneration) {
        return {
          text:
            `Monitor session ended while ${displayKey} was starting. ${startupNotice} ` +
            "No active monitor remains.",
        }
      }
      if (!owned()) {
        return { text: `Start of ${displayKey} was canceled. ${startupNotice} No active monitor remains.` }
      }
      const resetRace = this.watches.get(key)
      if (resetRace) {
        return { text: `Already monitoring ${displayKey} in this session.\n${resetRace.watch.statusLine()}` }
      }
    }

    const reportChannel = options.createChannel({ target, config })
    let timer: unknown
    const watch = new PrWatch({
      target,
      config,
      initial,
      deps: {
        now: this.deps.now,
        fetchSnapshot: () => this.fetchSnapshot({ target, config }),
        deliver: (report) => reportChannel.deliver({ report }),
        persist:
          reportChannel.persist === undefined
            ? undefined
            : (report) => reportChannel.persist?.({ report }) ?? Promise.resolve(),
        log: this.deps.log,
        onStopped: () => {
          this.deps.cancel({ timer })
          const entry = this.watches.get(key)
          if (entry?.watch === watch) {
            this.watches.delete(key)
            this.notifyWatchChanged({ type: WatchChangeType.stopped, target, config })
          }
        },
        readiness: {
          label: config.readyLabel,
          replyPrefix: config.ignoreCommentTag ?? "<!-- pr-monitor:reply -->",
          change: (ready) =>
            ready
              ? addReadyLabel(this.deps.runGh, target, config.readyLabel)
              : removeReadyLabel(this.deps.runGh, target, config.readyLabel),
          onChanged: (ready) => this.notifyReadyChanged({ target, ready, watched: true, config }),
        },
        autoMerge: this.autoMergeDeps({ target, enabled: config.autoMerge }),
        startupNotice,
      },
    })
    timer = this.deps.schedule({
      intervalMs: config.pollIntervalSeconds * 1000,
      callback: () => {
        void watch.tick().finally(() => this.notifyTickSettled({ target, config }))
      },
    })
    this.watches.set(key, { watch, timer, config, channel: reportChannel })
    this.notifyWatchChanged({ type: WatchChangeType.started, target, config })

    let announcement = InitialAnnouncementState.disabled
    if (options.announcementMode === InitialAnnouncementMode.awaitDelivery) {
      if (config.announceOnStart) {
        announcement = (await watch.announceInitial())
          ? InitialAnnouncementState.delivered
          : InitialAnnouncementState.retrying
      } else {
        await watch.initializeReadiness()
      }
      if (watch.isStopped) {
        return { text: `Monitor for ${displayKey} stopped before startup completed; no active monitor remains.` }
      }
    } else if (config.announceOnStart) {
      announcement = InitialAnnouncementState.pending
      void watch.announceInitial()
    } else {
      void watch.initializeReadiness()
    }

    this.deps.log(`started monitoring ${displayKey}`)
    const autoMergeNotice = config.autoMerge ? ` Auto-merge enabled: ${AUTO_MERGE_GUIDANCE}` : ""
    const resetNotice = startupNotice === undefined ? "" : ` Startup safety reset: ${startupNotice}`
    return {
      text: `Started monitoring ${displayKey} — "${initial.title}".${autoMergeNotice}${resetNotice}`,
      start: { target, config, announcement },
    }
  }

  private select({ pr }: { pr: string }): WatchEntry<TConfig>[] | { error: string } {
    if (pr === "all") return [...this.watches.values()]
    const target = parseTarget(pr)
    if ("error" in target) return target
    const entry = this.watches.get(targetRegistryKey(target))
    if (!entry) {
      return {
        error: `No monitor for ${targetKey(target)} in this session. Use action "status" to list active monitors.`,
      }
    }
    return [entry]
  }

  private async stop({ pr }: { pr: string }): Promise<MonitorActionResult<TConfig>> {
    if (pr === "all") {
      this.starting.clear()
      await Promise.all(this.startupResets.values())
    } else {
      const target = parseTarget(pr)
      const key = "error" in target ? undefined : targetRegistryKey(target)
      if (key !== undefined && !this.watches.has(key) && this.starting.delete(key)) {
        await this.startupResets.get(key)
        return { text: `Canceled the pending start for ${targetKey(target as Target)}.` }
      }
    }
    const selected = this.select({ pr })
    if ("error" in selected) return { text: selected.error }
    if (selected.length === 0) return { text: "No active monitors in this session." }
    for (const entry of selected) entry.watch.stop()
    await Promise.all(selected.map((entry) => entry.watch.waitUntilStopped()))
    return {
      text:
        `Stopped ${selected.length} monitor(s): ` +
        `${selected.map((entry) => targetKey(entry.watch.target)).join(", ")}.`,
    }
  }

  private async flush({ pr }: { pr: string }): Promise<MonitorActionResult<TConfig>> {
    const selected = this.select({ pr })
    if ("error" in selected) return { text: selected.error }
    if (selected.length === 0) return { text: "No active monitors in this session." }
    const reports = await Promise.all(selected.map((entry) => entry.watch.manualFlush()))
    return { text: reports.join("\n\n") }
  }

  private status(): string {
    if (this.watches.size === 0) return "No active monitors in this session."
    return [...this.watches.values()]
      .map(({ watch, config }) => {
        let suffix = ""
        try {
          suffix = this.deps.statusSuffix?.({ target: watch.target, config }) ?? ""
        } catch (error) {
          this.deps.log(`status decoration failed for ${targetKey(watch.target)}: ${error}`)
        }
        return `${watch.statusLine()}${suffix}`
      })
      .join("\n")
  }

  private async changeReady({
    pr,
    ready,
    loadConfig,
  }: {
    pr: string
    ready: boolean
    loadConfig: () => Promise<TConfig>
  }): Promise<MonitorActionResult<TConfig>> {
    const target = parseTarget(pr)
    if ("error" in target) return { text: target.error }
    const key = targetRegistryKey(target)
    const displayKey = targetKey(target)
    try {
      const watchedEntry = this.watches.get(key)
      if (watchedEntry !== undefined) {
        const text = await watchedEntry.watch.manualSetReady(ready)
        return {
          text,
          ready: { target: watchedEntry.watch.target, ready, watched: true },
        }
      }
      return await this.trackStandaloneReadinessMutation({
        mutation: () => this.changeStandaloneReady({ target, ready, loadConfig }),
      })
    } catch (error) {
      const action = ready ? `mark ${displayKey} as ready` : `withdraw the ready label from ${displayKey}`
      return { text: `Cannot ${action}: ${(error as Error).message}` }
    }
  }

  private autoMergeDeps({ target, enabled }: { target: Target; enabled: boolean }): AutoMergeDeps | undefined {
    if (!enabled) return undefined
    return {
      squashMerge: ({ pullRequest }) => squashMergePullRequest({ runGh: this.deps.runGh, target, pullRequest }),
    }
  }

  private async setAutoMerge({ pr, autoMerge }: { pr: string; autoMerge: boolean }): Promise<MonitorActionResult<TConfig>> {
    const selected = this.select({ pr })
    if ("error" in selected) {
      return { text: `${selected.error} To monitor it with auto-merge ${autoMerge ? "on" : "off"}, use start with autoMerge.` }
    }
    const entry = selected[0]!
    const displayKey = targetKey(entry.watch.target)
    try {
      const text = await entry.watch.setAutoMerge(this.autoMergeDeps({ target: entry.watch.target, enabled: autoMerge }))
      entry.config = { ...entry.config, autoMerge }
      return { text: autoMerge ? `${text} ${AUTO_MERGE_GUIDANCE}` : text }
    } catch (error) {
      return { text: `Cannot change auto-merge for ${displayKey}: ${(error as Error).message}` }
    }
  }

  private async changeStandaloneReady({
    target,
    ready,
    loadConfig,
  }: {
    target: Target
    ready: boolean
    loadConfig: () => Promise<TConfig>
  }): Promise<MonitorActionResult<TConfig>> {
    const config = await loadConfig()
    const acceptedPullRequest = ready && config.autoMerge
      ? await getAutoMergePullRequest({ runGh: this.deps.runGh, target })
      : undefined
    let effectiveReady = ready
    let text = ready
      ? await addReadyLabel(this.deps.runGh, target, config.readyLabel)
      : await removeReadyLabel(this.deps.runGh, target, config.readyLabel)
    if (acceptedPullRequest !== undefined) {
      let revalidatedPullRequest: AutoMergePullRequest | undefined
      try {
        revalidatedPullRequest = await getAutoMergePullRequest({ runGh: this.deps.runGh, target })
      } catch (error) {
        const withdrawal = await this.withdrawUnsafeStandaloneReadiness({
          target,
          config,
          reason:
            "the accepted head could not be revalidated after labeling " +
            `(${error instanceof Error ? error.message : String(error)})`,
        })
        effectiveReady = !withdrawal.removed
        text += `\n${withdrawal.text}`
      }
      if (revalidatedPullRequest !== undefined && revalidatedPullRequest.headSha !== acceptedPullRequest.headSha) {
        const withdrawal = await this.withdrawUnsafeStandaloneReadiness({
          target,
          config,
          reason:
            `the PR head changed from ${acceptedPullRequest.headSha} to ${revalidatedPullRequest.headSha} ` +
            "while readiness was being applied",
        })
        effectiveReady = !withdrawal.removed
        text += `\n${withdrawal.text}`
      } else if (revalidatedPullRequest !== undefined) {
        try {
          text += `\n${await squashMergePullRequest({
            runGh: this.deps.runGh,
            target,
            pullRequest: revalidatedPullRequest,
          })}`
        } catch (error) {
          if (error instanceof AutoMergeHeadChangedError) {
            const withdrawal = await this.withdrawUnsafeStandaloneReadiness({
              target,
              config,
              reason: error.message,
            })
            effectiveReady = !withdrawal.removed
            text += `\n${withdrawal.text}`
          } else {
            const failure = autoMergeFailureText({ error })
            this.deps.log(`auto-merge failed for ${targetKey(target)}: ${error}`)
            text += `\n${failure}`
          }
        }
      }
    }
    this.notifyReadyChanged({ target, ready: effectiveReady, watched: false, config })
    return { text, ready: { target, ready: effectiveReady, watched: false } }
  }

  private async withdrawUnsafeStandaloneReadiness({
    target,
    config,
    reason,
  }: {
    target: Target
    config: TConfig
    reason: string
  }): Promise<{ text: string; removed: boolean }> {
    const canceled = `Auto-merge canceled because ${reason}.`
    try {
      const removed = await removeReadyLabel(this.deps.runGh, target, config.readyLabel)
      return { text: `${canceled} ${removed}`, removed: true }
    } catch (error) {
      this.deps.log(`unsafe standalone readiness cleanup failed for ${targetKey(target)}: ${error}`)
      return {
        text:
          `${canceled} WARNING: label "${config.readyLabel}" could not be removed ` +
          `(${error instanceof Error ? error.message : String(error)}); remove it manually before reassessing the PR.`,
        removed: false,
      }
    }
  }

  private fetchSnapshot({ target, config }: { target: Target; config: TConfig }): Promise<PrSnapshot> {
    return fetchPrSnapshot({
      runGh: this.deps.runGh,
      target,
      ignoreTag: config.ignoreCommentTag,
      selfLogin: this.selfLogin,
    })
  }

  private notifyWatchChanged(event: { type: WatchChangeType; target: Target; config: TConfig }): void {
    try {
      this.deps.onWatchChanged?.(event)
    } catch (error) {
      this.deps.log(`watch ${event.type} observer failed for ${targetKey(event.target)}: ${error}`)
    }
  }

  private notifyTickSettled(event: { target: Target; config: TConfig }): void {
    try {
      this.deps.onTickSettled?.(event)
    } catch (error) {
      this.deps.log(`tick observer failed for ${targetKey(event.target)}: ${error}`)
    }
  }

  private notifyReadyChanged(event: { target: Target; ready: boolean; watched: boolean; config: TConfig }): void {
    try {
      this.deps.onReadyChanged?.(event)
    } catch (error) {
      this.deps.log(`ready-state observer failed for ${targetKey(event.target)}: ${error}`)
    }
  }
}
