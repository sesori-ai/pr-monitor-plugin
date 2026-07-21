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
import { loadConfig, type MonitorConfig } from "../src/config"
import { fetchPrSnapshot, type PrSnapshot } from "../src/github"
import { markReadyForHumanReview } from "../src/label"
import { parseTarget, targetKey, targetUrl, type Target } from "../src/target"
import { PrWatch } from "../src/watch"
import { createNodeGhRunner } from "./gh"
import { collectDeadSpools, notifyDesktop, probeSpool, spoolReport } from "./spool"

const claudePid = process.ppid
const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()

type Entry = { watch: PrWatch; timer: ReturnType<typeof setInterval> }
const watches = new Map<string, Entry>() // key: owner/repo#n

let selfLogin: string | undefined

const log = (message: string): void => {
  // stderr goes to Claude Code's MCP server logs; stdout is the MCP protocol.
  console.error(`[pr-monitor] ${message}`)
}

const runGh = createNodeGhRunner()

const fetchSnapshot = (target: Target, config: MonitorConfig): Promise<PrSnapshot> =>
  fetchPrSnapshot({ runGh, target, ignoreTag: config.ignoreCommentTag, selfLogin })

const deliver = (target: Target, config: MonitorConfig) => async (report: string): Promise<void> => {
  spoolReport(claudePid, report)
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
        if (entry?.watch === watch) watches.delete(key)
      },
    },
  })
  const timer = setInterval(() => void watch.tick(), config.pollIntervalSeconds * 1000)
  watches.set(key, { watch, timer })
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
    `is merged or closed, and does not survive this Claude Code session.`
  )
}

const markReady = async (pr: string): Promise<string> => {
  const target = parseTarget(pr)
  if ("error" in target) return target.error
  const config = await loadConfig(
    [join(projectDir, ".claude", "pr-monitor.json"), join(projectDir, ".opencode", "pr-monitor.json")],
    log,
  )
  try {
    return await markReadyForHumanReview(runGh, target, config.readyLabel)
  } catch (error) {
    return `Cannot mark ${targetKey(target)} as ready for human review: ${(error as Error).message}`
  }
}

const handle = async (action: "start" | "stop" | "flush" | "status" | "mark_ready", pr: string | undefined): Promise<string> => {
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
      return [...watches.values()].map((entry) => entry.watch.statusLine()).join("\n")
    }
    case "mark_ready": {
      if (!pr || pr === "all") return "action 'mark_ready' requires a single explicit pr: 'owner/repo#123' or a PR URL."
      return await markReady(pr)
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
  process.exit(0)
}
process.stdin.on("end", shutdown)
process.stdin.on("close", shutdown)
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

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
      "signal a human should review now; does not require an active monitor). The pr argument must be explicit " +
      "'owner/repo#123' or a full PR URL; 'all' is allowed for stop/flush. Tuning lives in .claude/pr-monitor.json. " +
      "Monitors are per-session and do not survive Claude Code restarts.",
    inputSchema: {
      action: z.enum(["start", "stop", "flush", "status", "mark_ready"]).describe("What to do"),
      pr: z
        .string()
        .optional()
        .describe(
          "PR identifier: 'owner/repo#123' or PR URL. Required for start/stop/flush/mark_ready; 'all' allowed for stop/flush.",
        ),
    },
  },
  async ({ action, pr }) => ({ content: [{ type: "text", text: await handle(action, pr) }] }),
)

await server.connect(new StdioServerTransport())
log(`pr-monitor MCP server ready (claude pid ${claudePid}, project ${projectDir})`)
