// pr-monitor — Claude Code adapter. The MCP process owns one logical session;
// reports are spooled for hooks to inject because Claude Code has no push API.

import { join } from "node:path"
import process from "node:process"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { loadClaudeConfig, type ClaudeMonitorConfig } from "../../core/config"
import { targetKey, targetRegistryKey, type Target } from "../../core/target"
import {
  InitialAnnouncementMode,
  InitialAnnouncementState,
  MonitorSession,
  StopNoticeChannel,
  WatchChangeType,
  type MonitorActionResult,
} from "../../runtime/monitor-session"
import { createNodeGhRunner } from "../../runtime/node-gh"
import {
  buildMonitorToolDescription,
  MONITOR_ACTION_VALUES,
  MonitorAction,
} from "../../runtime/tool"
import { writeSessionState } from "./session-state"
import { claimSpool, collectDeadSpools, notifyDesktop, probeSpool, spoolReport } from "./spool"

const claudePid = process.ppid
const projectDir = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd()
const configPaths = [
  join(projectDir, ".pr-monitor.json"),
  join(projectDir, ".claude", "pr-monitor.json"),
  join(projectDir, ".opencode", "pr-monitor.json"),
]

const handedOff = new Set<string>()
let keepAliveUntilMs = 0
const STATE_LIVENESS_FLOOR_MS = 5 * 60_000

const log = (message: string): void => {
  // stderr is the MCP log channel; stdout is reserved for the protocol.
  console.error(`[pr-monitor] ${message}`)
}

const runGh = createNodeGhRunner()
let monitorSession: MonitorSession<ClaudeMonitorConfig>

const refreshSessionState = (): void => {
  const watches = monitorSession.list()
  const active = watches.filter(({ target }) => !handedOff.has(targetRegistryKey(target)))
  const pollMs = Math.max(...watches.map(({ config }) => config.pollIntervalSeconds * 1000), 0)
  writeSessionState(claudePid, {
    version: 1,
    keepAlive: active.some(({ config }) => config.keepAlive),
    expiresAtMs: Date.now() + Math.max(pollMs * 3 + 60_000, STATE_LIVENESS_FLOOR_MS),
    keepAliveUntilMs,
    monitors: active.map(({ target }) => targetKey(target)),
  })
}

const extendKeepAlive = ({ config }: { config: ClaudeMonitorConfig }): void => {
  keepAliveUntilMs = Math.max(keepAliveUntilMs, Date.now() + config.keepAliveMaxMinutes * 60_000)
}

const deliver = ({
  target,
  config,
  report,
}: {
  target: Target
  config: ClaudeMonitorConfig
  report: string
}): Promise<void> => {
  spoolReport(claudePid, report)
  extendKeepAlive({ config })
  refreshSessionState()
  if (config.desktopNotifications) {
    notifyDesktop(`PR Monitor — ${targetKey(target)}`, "New report waiting in your Claude Code session")
  }
  return Promise.resolve()
}

monitorSession = new MonitorSession<ClaudeMonitorConfig>({
  runGh,
  loadConfig: () => loadClaudeConfig({ paths: configPaths, log }),
  log,
  onWatchChanged: ({ type, target, config }) => {
    if (type === WatchChangeType.started) extendKeepAlive({ config })
    else handedOff.delete(targetRegistryKey(target))
    refreshSessionState()
  },
  onTickSettled: refreshSessionState,
  onReadyChanged: ({ target, ready, watched, config }) => {
    if (ready && watched) handedOff.add(targetRegistryKey(target))
    if (!ready) {
      handedOff.delete(targetRegistryKey(target))
      if (watched) extendKeepAlive({ config })
    }
    refreshSessionState()
  },
  statusSuffix: ({ target }) =>
    handedOff.has(targetRegistryKey(target)) ? ", handed off for human review" : "",
})

const prepareStart = async (): Promise<string | undefined> => {
  try {
    probeSpool(claudePid)
    return undefined
  } catch (error) {
    return (
      `Cannot start monitor: the report spool is not writable (${(error as Error).message}). ` +
      "Reports could not be delivered. Check permissions on ~/.claude/pr-monitor."
    )
  }
}

const formatResult = ({ result }: { result: MonitorActionResult<ClaudeMonitorConfig> }): string => {
  if (result.start !== undefined) {
    const { config, announcement } = result.start
    const replyPrefix = config.ignoreCommentTag ?? "<!-- pr-monitor:reply -->"
    return (
      `${result.text}\n` +
      (config.announceOnStart
        ? announcement === InitialAnnouncementState.delivered
          ? "An initial [PR Monitor] report is spooled for the next hook event. "
          : "Initial delivery failed and will retry at the next poll without losing its baseline. "
        : "") +
      `Polling every ${config.pollIntervalSeconds}s; settled activity is injected automatically ` +
      `at the next tool call, user message, or turn end after ${config.debounceMinutes} quiet minutes. ` +
      (config.flushOnCiFailure
        ? "A failing check is reported at the next poll without waiting for the quiet window or the rest of CI. "
        : "") +
      "A new merge conflict or terminal state is also immediate. " +
      `Readiness is managed automatically; agent-authored GitHub replies must begin with \`${replyPrefix}\`. ` +
      "Use mark_ready when new feedback is non-actionable and no reply should be posted. " +
      "Never invent sleeps, scheduled checks, polling loops, repeated CI checks, or routine status/flush calls. " +
      "The monitor stops on merge/close and does not survive this Claude Code session." +
      (config.keepAlive
        ? "\nKeep-alive follows the ready label. Run only the exact await-activity command supplied by a " +
          "[PR Monitor keep-alive] message; do not create another waiting mechanism."
        : "")
    )
  }
  if (result.ready?.ready && result.ready.watched) {
    return (
      `${result.text}\nStill monitoring it, but it no longer holds this session open; ` +
      "new activity re-opens the work loop."
    )
  }
  return result.text
}

const handle = async ({
  action,
  pr,
}: {
  action: MonitorAction
  pr: string | undefined
}): Promise<string> => {
  const result = await monitorSession.execute({
    action,
    pr,
    start:
      action === MonitorAction.start
        ? {
            prepare: prepareStart,
            announcementMode: InitialAnnouncementMode.awaitDelivery,
            createChannel: ({ target, config }) => ({
              deliver: ({ report }) => deliver({ target, config, report }),
              persist: ({ report }) => {
                spoolReport(claudePid, report)
                return Promise.resolve()
              },
            }),
          }
        : undefined,
  })
  return formatResult({ result })
}

// Restarted MCP servers share the same Claude pid/spool, so a stop notice can
// survive reconnect; a dead-session spool is later garbage-collected.
let shuttingDown = false
const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  void (async () => {
    await monitorSession.stopAll({
      notice:
        "Monitor stopped: the pr-monitor MCP server is shutting down " +
        "(Claude Code session ended or server restarted). Re-start monitoring if still needed.",
      channel: StopNoticeChannel.persistent,
    })
    writeSessionState(claudePid, {
      version: 1,
      keepAlive: false,
      expiresAtMs: 0,
      keepAliveUntilMs: 0,
      monitors: [],
    })
    process.exit(0)
  })()
}
process.stdin.on("end", shutdown)
process.stdin.on("close", shutdown)
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

claimSpool(claudePid)
collectDeadSpools(claudePid)

const server = new McpServer({ name: "pr-monitor", version: "0.3.1" })

server.registerTool(
  "pr_monitor",
  {
    description: buildMonitorToolDescription({
      delivery: "reports are injected into THIS session as '[PR Monitor]' messages at hook events.",
      configPath:
        ".pr-monitor.json (falling back to .claude/pr-monitor.json, then .opencode/pr-monitor.json)",
      lifecycle: "Monitors are per-session and do not survive Claude Code restarts.",
      waiting:
        "End the turn when idle. If a [PR Monitor keep-alive] message supplies an await-activity command, run only " +
        "that exact event waiter; never invent another delay or polling mechanism.",
    }),
    inputSchema: {
      action: z.enum(MONITOR_ACTION_VALUES).describe("What to do"),
      pr: z
        .string()
        .optional()
        .describe(
          "PR identifier: 'owner/repo#123' or PR URL. Required for start/stop/flush/mark_ready/unmark_ready; " +
            "'all' allowed for stop/flush.",
        ),
    },
  },
  async ({ action, pr }) => ({ content: [{ type: "text", text: await handle({ action, pr }) }] }),
)

await server.connect(new StdioServerTransport())
log(`pr-monitor MCP server ready (claude pid ${claudePid}, project ${projectDir})`)
