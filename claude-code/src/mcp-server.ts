// pr-monitor — Claude Code shell: an MCP stdio server that watches GitHub PRs
// and spools factual [PR Monitor] reports for the plugin's hooks to inject
// into the owning Claude Code conversation.
//
// Claude Code spawns one stdio MCP server per Claude Code process and kills it
// when the process exits, so "this session's monitors" is simply this
// process's watches map — the per-session semantics of the opencode shell fall
// out of the process model. Delivery is passive (Claude Code has no way to
// push a message into a session): deliver() writes a report file into the
// spool keyed by the parent Claude Code pid; the plugin's UserPromptSubmit /
// PostToolUse / Stop hooks drain the spool into the conversation at the next
// hook event. See hooks/drain-spool.mjs.

import { join } from "node:path"
import process from "node:process"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { loadConfig, type MonitorConfig } from "../../core/config"
import { fetchPrSnapshot, type PrSnapshot } from "../../core/github"
import { markReadyForHumanReview, removeReadyForHumanReview } from "../../core/label"
import { parseTarget, targetKey, targetUrl, type Target } from "../../core/target"
import { PrWatch } from "../../core/watch"
import { createNodeGhRunner } from "./gh"
import { writeSessionState } from "./session-state"
import { claimSpool, collectDeadSpools, notifyDesktop, probeSpool, spoolReport } from "./spool"

const claudePid = process.ppid
const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()

type Entry = { watch: PrWatch; timer: ReturnType<typeof setInterval>; config: MonitorConfig }
const watches = new Map<string, Entry>() // key: owner/repo#n

// Targets handed off to a human via mark_ready. They keep being monitored, but
// they no longer hold the keep-alive loop open: the session's job on them is
// done until someone says otherwise. Any delivered report clears the handoff —
// new activity on a PR that was flagged ready is precisely the human feedback
// the loop exists to pick back up.
const handedOff = new Set<string>()

let selfLogin: string | undefined

// Rolling idle deadline for the keep-alive loop, extended by every delivered
// report. Bounds how long a session waits with nothing happening; work itself
// is unbounded, since work produces reports.
let keepAliveUntilMs = 0

const STATE_LIVENESS_FLOOR_MS = 5 * 60_000

/**
 * Publish keep-alive state for the hooks. Called on every change to the watch
 * set or the handoff set, and after every poll tick — the tick refresh is what
 * proves to the hooks that this server is still alive (see session-state.ts).
 */
const refreshSessionState = (): void => {
  const active = [...watches.entries()].filter(([key]) => !handedOff.has(key))
  const pollMs = Math.max(...[...watches.values()].map((entry) => entry.config.pollIntervalSeconds * 1000), 0)
  writeSessionState(claudePid, {
    version: 1,
    keepAlive: active.some(([, entry]) => entry.config.keepAlive),
    expiresAtMs: Date.now() + Math.max(pollMs * 3 + 60_000, STATE_LIVENESS_FLOOR_MS),
    keepAliveUntilMs,
    monitors: active.map(([key]) => key),
  })
}

const extendKeepAlive = (config: MonitorConfig): void => {
  keepAliveUntilMs = Math.max(keepAliveUntilMs, Date.now() + config.keepAliveMaxMinutes * 60_000)
}

const log = (message: string): void => {
  // stderr goes to Claude Code's MCP server logs; stdout is the MCP protocol.
  console.error(`[pr-monitor] ${message}`)
}

const runGh = createNodeGhRunner()

const fetchSnapshot = (target: Target, config: MonitorConfig): Promise<PrSnapshot> =>
  fetchPrSnapshot({ runGh, target, ignoreTag: config.ignoreCommentTag, selfLogin })

const deliver = (target: Target, config: MonitorConfig) => async (report: string): Promise<void> => {
  spoolReport(claudePid, report)
  // Activity on a handed-off PR means someone came back to it (a human comment,
  // a new review, CI on their push): take the PR back and re-arm the loop.
  handedOff.delete(targetKey(target))
  extendKeepAlive(config)
  refreshSessionState()
  if (config.desktopNotifications) {
    notifyDesktop(`PR Monitor — ${targetKey(target)}`, "New report waiting in your Claude Code session")
  }
}

const selectWatches = (pr: string): PrWatch[] | { error: string } => {
  if (pr === "all") return [...watches.values()].map((entry) => entry.watch)
  const target = parseTarget(pr)
  if ("error" in target) return target
  const entry = watches.get(targetKey(target))
  if (!entry) return { error: `No monitor for ${targetKey(target)} in this session. Use action "status" to list active monitors.` }
  return [entry.watch]
}

const startWatch = async (pr: string): Promise<string> => {
  const target = parseTarget(pr)
  if ("error" in target) return target.error
  const key = targetKey(target)
  const existing = watches.get(key)
  if (existing) return `Already monitoring ${key} in this session.\n${existing.watch.statusLine()}`

  // The spool is the only delivery channel; if it is unwritable every report
  // would vanish into stderr logs while the tool claims success. Fail loudly.
  try {
    probeSpool(claudePid)
  } catch (error) {
    return `Cannot start monitor: the report spool is not writable (${(error as Error).message}). Reports could not be delivered. Check permissions on ~/.claude/pr-monitor.`
  }

  const config = await loadConfig(
    [join(projectDir, ".claude", "pr-monitor.json"), join(projectDir, ".opencode", "pr-monitor.json")],
    log,
  )
  if (config.ignoreCommentTag !== undefined && selfLogin === undefined) {
    try {
      selfLogin = (await runGh(["api", "user", "--jq", ".login"])).trim()
    } catch (error) {
      return `Cannot start monitor: ignoreCommentTag is configured but resolving the authenticated gh user failed (${(error as Error).message}). Run \`gh auth status\` to check.`
    }
  }

  let initial: PrSnapshot
  try {
    initial = await fetchSnapshot(target, config)
  } catch (error) {
    return `Cannot start monitor for ${key}: ${(error as Error).message}`
  }
  if (initial.state !== "OPEN") return `Cannot start monitor: ${key} is already ${initial.state}.`

  // Re-check after the awaits above: MCP requests are dispatched concurrently,
  // so a parallel start for the same PR may have won the race while this call
  // was waiting on gh. From here to watches.set is synchronous — no new race.
  const raced = watches.get(key)
  if (raced) return `Already monitoring ${key} in this session.\n${raced.watch.statusLine()}`

  const watch = new PrWatch({
    target,
    sessionID: String(claudePid),
    config,
    initial,
    deps: {
      now: Date.now,
      fetchSnapshot: () => fetchSnapshot(target, config),
      deliver: deliver(target, config),
      log,
      onStopped: () => {
        // Clear only this watch's own timer, and only remove the map entry if
        // it is still ours — never tear down a successor watch under the key.
        clearInterval(timer)
        const entry = watches.get(key)
        if (entry?.watch === watch) {
          watches.delete(key)
          handedOff.delete(key)
          refreshSessionState()
        }
      },
    },
  })
  // The post-tick refresh is the server's liveness heartbeat for the hooks, so
  // it must run whether the tick found anything or not.
  const timer = setInterval(() => {
    void watch.tick().finally(refreshSessionState)
  }, config.pollIntervalSeconds * 1000)
  watches.set(key, { watch, timer, config })
  extendKeepAlive(config)
  refreshSessionState()
  // Announce the current state immediately so the session knows its starting
  // point and can address anything already outstanding on the PR. Awaited so
  // the report is spooled before this tool call returns — the PostToolUse hook
  // that fires right after it then injects the report immediately.
  if (config.announceOnStart) await watch.announceInitial()
  log(`started monitoring ${key} for Claude Code pid ${claudePid}`)
  return (
    `Started monitoring ${key} — "${initial.title}".\n` +
    (config.announceOnStart ? `An initial [PR Monitor] status report has been spooled and will be injected into this conversation at the next hook event. ` : "") +
    `Polling every ${config.pollIntervalSeconds}s; after activity settles for ${config.debounceMinutes} quiet minutes, a report is ` +
    `injected into this conversation at your next tool call, user message, or turn end. The monitor stops automatically when the PR ` +
    `is merged or closed, and does not survive this Claude Code session.` +
    (config.keepAlive
      ? `\nKeep-alive is on: until this PR is handed off with action 'mark_ready', turn-end is refused and you are asked to wait for ` +
        `the next report rather than going idle. Follow the monitor-pr skill; action 'stop' ends it at any time.`
      : "")
  )
}

const loadProjectConfig = (): Promise<MonitorConfig> =>
  loadConfig([join(projectDir, ".claude", "pr-monitor.json"), join(projectDir, ".opencode", "pr-monitor.json")], log)

const markReady = async (pr: string): Promise<string> => {
  const target = parseTarget(pr)
  if ("error" in target) return target.error
  const config = await loadProjectConfig()
  try {
    const result = await markReadyForHumanReview(runGh, target, config.readyLabel)
    // The handoff: keep monitoring, but stop holding the session open for this
    // PR. Any later report on it takes the PR back (see deliver()).
    //
    // Only meaningful for a PR this session is actually watching. Recording it
    // for an unwatched one would leave a stale entry that silently disables
    // keep-alive for a monitor started later under the same key — the label is
    // applied either way, but the handoff is watch state, not label state.
    if (watches.has(targetKey(target))) {
      handedOff.add(targetKey(target))
      refreshSessionState()
    }
    return watches.has(targetKey(target))
      ? `${result}\nStill monitoring it, but it no longer holds this session open — new activity on it will re-open the work loop.`
      : result
  } catch (error) {
    return `Cannot mark ${targetKey(target)} as ready for human review: ${(error as Error).message}`
  }
}

const unmarkReady = async (pr: string): Promise<string> => {
  const target = parseTarget(pr)
  if ("error" in target) return target.error
  const config = await loadProjectConfig()
  try {
    const result = await removeReadyForHumanReview(runGh, target, config.readyLabel)
    handedOff.delete(targetKey(target))
    refreshSessionState()
    return result
  } catch (error) {
    return `Cannot withdraw the ready-for-human-review label from ${targetKey(target)}: ${(error as Error).message}`
  }
}

const handle = async (
  action: "start" | "stop" | "flush" | "status" | "mark_ready" | "unmark_ready",
  pr: string | undefined,
): Promise<string> => {
  switch (action) {
    case "start": {
      if (!pr || pr === "all") return "action 'start' requires a single explicit pr: 'owner/repo#123' or a PR URL."
      return await startWatch(pr)
    }
    case "stop": {
      if (!pr) return "action 'stop' requires pr: 'owner/repo#123', a PR URL, or 'all'."
      const selected = selectWatches(pr)
      if ("error" in selected) return selected.error
      if (selected.length === 0) return "No active monitors in this session."
      for (const watch of selected) watch.stop()
      return `Stopped ${selected.length} monitor(s): ${selected.map((watch) => targetKey(watch.target)).join(", ")}.`
    }
    case "flush": {
      if (!pr) return "action 'flush' requires pr: 'owner/repo#123', a PR URL, or 'all'."
      const selected = selectWatches(pr)
      if ("error" in selected) return selected.error
      if (selected.length === 0) return "No active monitors in this session."
      const reports = await Promise.all(selected.map((watch) => watch.manualFlush()))
      return reports.join("\n\n")
    }
    case "status": {
      if (watches.size === 0) return "No active monitors in this session."
      return [...watches.values()]
        .map((entry) => {
          const line = entry.watch.statusLine()
          return handedOff.has(targetKey(entry.watch.target)) ? `${line}, handed off for human review` : line
        })
        .join("\n")
    }
    case "mark_ready": {
      if (!pr || pr === "all") return "action 'mark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL."
      return await markReady(pr)
    }
    case "unmark_ready": {
      if (!pr || pr === "all") return "action 'unmark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL."
      return await unmarkReady(pr)
    }
  }
}

// Claude Code restarts MCP servers on demand (e.g. /mcp reconnect) and kills
// them when the Claude Code process exits. Spool a factual stop notice for
// each active watch before exiting: after a server restart the same-pid spool
// survives and the notice reaches the conversation (mirroring the opencode
// shell's reload-takeover notices); after a real session end the dead-pid GC
// silently removes it.
let shuttingDown = false
const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  for (const entry of [...watches.values()]) {
    try {
      spoolReport(
        claudePid,
        `[PR Monitor] [${targetKey(entry.watch.target)}](${targetUrl(entry.watch.target)}) — Monitor stopped: the pr-monitor MCP server is shutting down (Claude Code session ended or server restarted). Re-start monitoring if still needed.`,
      )
    } catch {
      // best-effort notice
    }
    entry.watch.stop()
  }
  // Disarm keep-alive explicitly rather than leaving the hooks to notice the
  // expiry: a waiter blocked right now should return immediately, and the Stop
  // hook must not hold a session open for a server that is gone.
  writeSessionState(claudePid, {
    version: 1,
    keepAlive: false,
    expiresAtMs: 0,
    keepAliveUntilMs: 0,
    monitors: [],
  })
  process.exit(0)
}
process.stdin.on("end", shutdown)
process.stdin.on("close", shutdown)
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

// Both run before the server accepts a call, so the first hook event of this
// session can never read a spool that is not ours: claimSpool discards a dir
// inherited from a dead process that held this same pid, collectDeadSpools
// sweeps the dirs of other processes that are gone.
claimSpool(claudePid)
collectDeadSpools(claudePid)

const server = new McpServer({ name: "pr-monitor", version: "0.2.0" })

server.registerTool(
  "pr_monitor",
  {
    description:
      "Monitor a GitHub PR in the background. Detects CI suite conclusions, new reviews, new inline/issue comments, " +
      "mergeability changes, and merge/close. Changes are aggregated (rolling debounce) and injected into THIS session " +
      "as '[PR Monitor]' messages stating facts only, delivered at your next tool call, user message, or turn end. " +
      "Actions: start (begin watching a PR), stop (end watching), flush (on-demand: immediately return a full status " +
      "report and reset the 'new since' baseline; a delivered report already advances the baseline, so a flush after " +
      "handling one is not needed), status (list this session's monitors), mark_ready (add the configured " +
      "ready-for-human-review label to the PR on GitHub — use once CI is green and review feedback is addressed, to " +
      "signal a human should review now; this is also the handoff that releases the keep-alive loop), unmark_ready " +
      "(withdraw that label — use when new feedback arrives on a PR that was already flagged ready, before working on " +
      "it again). mark_ready/unmark_ready do not require an active monitor. The pr argument must be explicit " +
      "'owner/repo#123' or a full PR URL; 'all' is allowed for stop/flush. Tuning lives in .claude/pr-monitor.json. " +
      "Monitors are per-session and do not survive Claude Code restarts. While a monitored PR is not handed off, " +
      "keep-alive (config key 'keepAlive') refuses turn-end so reports arriving during idle time are still acted on — " +
      "follow the monitor-pr skill.",
    inputSchema: {
      action: z.enum(["start", "stop", "flush", "status", "mark_ready", "unmark_ready"]).describe("What to do"),
      pr: z
        .string()
        .optional()
        .describe(
          "PR identifier: 'owner/repo#123' or PR URL. Required for start/stop/flush/mark_ready/unmark_ready; 'all' allowed for stop/flush.",
        ),
    },
  },
  async ({ action, pr }) => ({ content: [{ type: "text", text: await handle(action, pr) }] }),
)

await server.connect(new StdioServerTransport())
log(`pr-monitor MCP server ready (claude pid ${claudePid}, project ${projectDir})`)
