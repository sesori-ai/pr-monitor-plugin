// pr-monitor — OpenCode adapter. The loader invokes EVERY export of this
// module as a plugin, so PrMonitorPlugin must remain the sole export.

import { join } from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { loadMonitorConfig, type MonitorConfig } from "../core/config"
import {
  InitialAnnouncementMode,
  InitialAnnouncementState,
  MonitorSession,
  StopNoticeChannel,
  type MonitorActionResult,
} from "../runtime/monitor-session"
import {
  buildMonitorToolDescription,
  MONITOR_ACTION_VALUES,
  MonitorAction,
} from "../runtime/tool"
import { createOpenCodeGhRunner } from "./gh"

export const PrMonitorPlugin: Plugin = async ({ client, directory, worktree, $ }) => {
  const sessions = new Map<string, MonitorSession<MonitorConfig>>()
  const sessionModels = new Map<string, { providerID: string; modelID: string }>()

  const log = (message: string): void => {
    void client.app.log({ body: { service: "pr-monitor", level: "info", message } }).catch(() => {})
  }
  const runGh = createOpenCodeGhRunner({ shell: $ })
  const configPaths = [...new Set([
    join(directory, ".pr-monitor.json"),
    join(worktree, ".pr-monitor.json"),
    join(directory, ".opencode", "pr-monitor.json"),
    join(worktree, ".opencode", "pr-monitor.json"),
  ])]

  const getSession = ({ sessionID }: { sessionID: string }): MonitorSession<MonitorConfig> => {
    const existing = sessions.get(sessionID)
    if (existing !== undefined) return existing
    const created = new MonitorSession<MonitorConfig>({
      runGh,
      loadConfig: () => loadMonitorConfig({ paths: configPaths, log }),
      log: (message) => log(`${message} for session ${sessionID}`),
    })
    sessions.set(sessionID, created)
    return created
  }

  // `agent` must be explicit: an agent-less prompt can resolve to a subagent.
  // promptAsync reports server failures in result.error instead of rejecting.
  const deliver = ({ sessionID, agent, report }: { sessionID: string; agent: string; report: string }) =>
    client.session
      .promptAsync({
        path: { id: sessionID },
        body: { agent, model: sessionModels.get(sessionID), parts: [{ type: "text", text: report }] },
      })
      .then((result) => {
        if (result.error !== undefined) throw new Error(`prompt_async rejected: ${JSON.stringify(result.error)}`)
      })

  // Disposal cancels promptAsync's background write, so shutdown notices use
  // synchronous prompt with noReply and return only after persistence.
  const persist = ({ sessionID, agent, report }: { sessionID: string; agent: string; report: string }) =>
    client.session
      .prompt({
        path: { id: sessionID },
        body: { agent, model: sessionModels.get(sessionID), noReply: true, parts: [{ type: "text", text: report }] },
      })
      .then((result) => {
        if (result.error !== undefined) throw new Error(`prompt rejected: ${JSON.stringify(result.error)}`)
      })

  const formatResult = ({ result }: { result: MonitorActionResult<MonitorConfig> }): string => {
    if (result.start === undefined) return result.text
    const { config, announcement } = result.start
    return (
      `${result.text}\n` +
      (announcement === InitialAnnouncementState.pending
        ? "An initial [PR Monitor] status report is being delivered now. "
        : "") +
      `Polling every ${config.pollIntervalSeconds}s; reports arrive automatically in this session after ` +
      `${config.debounceMinutes} quiet minutes following activity. ` +
      (config.flushOnCiFailure
        ? "A failing check is reported at the next poll without waiting for that quiet window or the rest of CI. "
        : "") +
      "A new merge conflict or terminal PR state is also reported at the next poll without waiting. " +
      "Do not schedule delays, polling loops, repeated CI checks, or routine status/flush calls while waiting. " +
      "The monitor stops on merge/close and does not survive an OpenCode restart."
    )
  }

  // Plugin reloads can leave old intervals alive. A same-directory successor
  // stops them and sends one factual notice to each owning session.
  const globalState = globalThis as { __sesoriPrMonitorTakeovers?: Map<string, () => void> }
  const takeovers = (globalState.__sesoriPrMonitorTakeovers ??= new Map())
  takeovers.get(directory)?.()
  takeovers.set(directory, () => {
    for (const session of sessions.values()) {
      void session.stopAll({
        notice: "Monitor stopped: the pr-monitor plugin was reloaded. Re-start monitoring if still needed.",
      })
    }
  })

  return {
    tool: {
      pr_monitor: tool({
        description: buildMonitorToolDescription({
          delivery: "reports are pushed into THIS session as '[PR Monitor]' messages.",
          configPath: ".pr-monitor.json (falling back to .opencode/pr-monitor.json)",
          lifecycle: "Monitors are per-session and do not survive OpenCode restarts.",
          waiting: "After start, end the turn whenever there is no delivered report to handle.",
        }),
        args: {
          action: tool.schema.enum(MONITOR_ACTION_VALUES).describe("What to do"),
          pr: tool.schema
            .string()
            .optional()
            .describe(
              "PR identifier: 'owner/repo#123' or PR URL. Required for start/stop/flush/mark_ready/unmark_ready; " +
                "'all' allowed for stop/flush.",
            ),
        },
        async execute(args, context) {
          const session = getSession({ sessionID: context.sessionID })
          const result = await session.execute({
            action: args.action,
            pr: args.pr,
            start:
              args.action === MonitorAction.start
                ? {
                    announcementMode: InitialAnnouncementMode.background,
                    createChannel: () => ({
                      deliver: ({ report }) => deliver({ sessionID: context.sessionID, agent: context.agent, report }),
                      persist: ({ report }) => persist({ sessionID: context.sessionID, agent: context.agent, report }),
                    }),
                  }
                : undefined,
          })
          return formatResult({ result })
        },
      }),
    },

    "chat.message": async (input) => {
      if (input.model !== undefined) sessionModels.set(input.sessionID, input.model)
    },

    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      const sessionID = (event.properties as { info?: { id?: string } })?.info?.id
      if (!sessionID) return
      const session = sessions.get(sessionID)
      if (session !== undefined) await session.stopAll({})
      sessions.delete(sessionID)
      sessionModels.delete(sessionID)
    },

    dispose: async () => {
      await Promise.all(
        [...sessions.values()].map((session) =>
          session.stopAll({
            notice:
              "Monitor stopped: opencode is shutting down. " +
              "Re-start monitoring after opencode starts if still needed.",
            channel: StopNoticeChannel.persistent,
          }),
        ),
      )
    },
  }
}
