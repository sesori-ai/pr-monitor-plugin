import { join } from "node:path"
import { StringEnum } from "@earendil-works/pi-ai"
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { loadMonitorConfig, type MonitorConfig } from "../core/config"
import type { GhRunner } from "../core/github"
import {
  InitialAnnouncementMode,
  InitialAnnouncementState,
  MonitorSession,
  type MonitorActionResult,
} from "../runtime/monitor-session"
import { createNodeGhRunner } from "../runtime/node-gh"
import {
  buildMonitorToolDescription,
  MONITOR_ACTION_VALUES,
  MonitorAction,
} from "../runtime/tool"

export type PiMonitorDependencies = {
  runGh?: GhRunner
  loadConfig?: (input: { context: ExtensionContext }) => Promise<MonitorConfig>
  log?: (message: string) => void
  schedule?: (input: { callback: () => void; intervalMs: number }) => unknown
  cancel?: (input: { timer: unknown }) => void
}

export type PiMonitorController = {
  dispose: () => Promise<void>
}

export function piMonitorConfigPaths({
  cwd,
  trusted,
  configDirectory,
}: {
  cwd: string
  trusted: boolean
  configDirectory: string
}): string[] {
  if (!trusted) return []
  return [
    join(cwd, ".pr-monitor.json"),
    join(cwd, configDirectory, "pr-monitor.json"),
    join(cwd, ".opencode", "pr-monitor.json"),
  ]
}

function formatResult({ result }: { result: MonitorActionResult<MonitorConfig> }): string {
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
    "End the turn when there is no delivered report to handle. Never create sleeps, scheduled checks, polling " +
    "loops, repeated CI checks, or routine status/flush calls. " +
    "The monitor stops on merge/close and does not survive a Pi-family session replacement or process restart."
  )
}

export function registerPiMonitor({
  pi,
  dependencies = {},
}: {
  pi: ExtensionAPI
  dependencies?: PiMonitorDependencies
}): PiMonitorController {
  const runGh = dependencies.runGh ?? createNodeGhRunner()
  const log =
    dependencies.log ??
    ((message: string) => {
      console.error(`[pr-monitor] ${message}`)
    })
  let currentSession: MonitorSession<MonitorConfig> | undefined
  const loadConfigForContext = ({ context }: { context: ExtensionContext }): Promise<MonitorConfig> => {
    const customLoadConfig = dependencies.loadConfig
    if (customLoadConfig !== undefined) return customLoadConfig({ context })
    return loadMonitorConfig({
      paths: piMonitorConfigPaths({
        cwd: context.cwd,
        trusted: context.isProjectTrusted(),
        configDirectory: CONFIG_DIR_NAME,
      }),
      log,
    })
  }

  const getSession = (): MonitorSession<MonitorConfig> => {
    if (currentSession !== undefined) return currentSession
    currentSession = new MonitorSession<MonitorConfig>({
      runGh,
      log,
      schedule: dependencies.schedule,
      cancel: dependencies.cancel,
    })
    return currentSession
  }

  const dispose = async (): Promise<void> => {
    const session = currentSession
    currentSession = undefined
    await session?.stopAll({})
  }

  pi.on("session_shutdown", dispose)
  pi.registerTool({
    name: "pr_monitor",
    label: "PR Monitor",
    description: buildMonitorToolDescription({
      delivery: "reports are pushed into THIS session as visible '[PR Monitor]' messages.",
      configPath: `.pr-monitor.json (falling back to ${CONFIG_DIR_NAME}/pr-monitor.json and .opencode/pr-monitor.json)`,
      lifecycle: "Monitors are session-scoped and do not survive session replacement or process restart.",
      waiting: "After start, end the turn whenever there is no delivered report to handle.",
    }),
    parameters: Type.Object({
      action: StringEnum(MONITOR_ACTION_VALUES, { description: "What to do" }),
      pr: Type.Optional(
        Type.String({
          description:
            "PR identifier: 'owner/repo#123' or PR URL. Required for start/stop/flush/mark_ready/unmark_ready; " +
            "'all' allowed for stop/flush.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      const result = await getSession().execute({
        action: params.action,
        pr: params.pr,
        loadConfig: () => loadConfigForContext({ context }),
        start:
          params.action === MonitorAction.start
            ? {
                announcementMode: InitialAnnouncementMode.background,
                createChannel: () => ({
                  deliver: ({ report }) => {
                    pi.sendMessage(
                      { customType: "pr-monitor", content: report, display: true },
                      { deliverAs: "steer", triggerTurn: true },
                    )
                    return Promise.resolve()
                  },
                }),
              }
            : undefined,
      })
      return {
        content: [{ type: "text", text: formatResult({ result }) }],
        details: { action: params.action },
      }
    },
  })

  return { dispose }
}
