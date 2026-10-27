// pr-monitor — OpenCode V2 adapter. OpenCode loads the default export of
// index.ts; this module builds that Promise-API plugin definition.

import { join } from "node:path"
import { Plugin, Skill } from "@opencode/plugin"
import { loadMonitorConfig, type MonitorConfig } from "../core/config"
import type { GhRunner } from "../core/github"
import {
  InitialAnnouncementMode,
  InitialAnnouncementState,
  MonitorSession,
  StopNoticeChannel,
  type MonitorActionResult,
} from "../runtime/monitor-session"
import { packageSkillDirectory } from "../runtime/package-skill"
import {
  AUTO_MERGE_PARAM_DESCRIPTION,
  BODY_PARAM_DESCRIPTION,
  buildMonitorToolDescription,
  MONITOR_ACTION_VALUES,
  THREAD_PARAM_DESCRIPTION,
  MonitorAction,
} from "../runtime/tool"
import { readPackagedSkill } from "./skill"

export const PLUGIN_ID = "sesori.pr-monitor"
export const TOOL_NAME = "pr_monitor"
export const UNLOAD_NOTICE =
  "Monitor stopped: the pr-monitor plugin was unloaded because OpenCode shut down or reloaded it. " +
  "Re-start monitoring if still needed."

type MonitorToolInput = { action: MonitorAction; pr?: string; autoMerge?: boolean; thread?: string; body?: string }

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...MONITOR_ACTION_VALUES], description: "What to do" },
    pr: {
      type: "string",
      description:
        "PR identifier: 'owner/repo#123' or PR URL. " +
        "Required for start/stop/flush/mark_ready/unmark_ready/set_auto_merge/feedback/reply; 'all' allowed for stop/flush.",
    },
    autoMerge: { type: "boolean", description: AUTO_MERGE_PARAM_DESCRIPTION },
    thread: { type: "string", description: THREAD_PARAM_DESCRIPTION },
    body: { type: "string", description: BODY_PARAM_DESCRIPTION },
  },
  required: ["action"],
  additionalProperties: false,
}

// OpenCode validates input against TOOL_INPUT_SCHEMA before execution; this
// narrows the JSON-schema `unknown` value to the typed shape.
function parseToolInput({ input }: { input: unknown }): MonitorToolInput {
  if (typeof input !== "object" || input === null) throw new Error("pr_monitor input must be an object")
  const fields = new Map<string, unknown>(Object.entries(input))
  const action = MONITOR_ACTION_VALUES.find((value) => value === fields.get("action"))
  if (action === undefined) throw new Error(`pr_monitor action must be one of: ${MONITOR_ACTION_VALUES.join(", ")}`)
  const pr = fields.get("pr")
  const autoMerge = fields.get("autoMerge")
  if (pr !== undefined && typeof pr !== "string") throw new Error("pr_monitor pr must be a string")
  if (autoMerge !== undefined && typeof autoMerge !== "boolean") {
    throw new Error("pr_monitor autoMerge must be a boolean")
  }
  const thread = fields.get("thread")
  const body = fields.get("body")
  if (thread !== undefined && typeof thread !== "string") throw new Error("pr_monitor thread must be a string")
  if (body !== undefined && typeof body !== "string") throw new Error("pr_monitor body must be a string")
  return { action, pr, autoMerge, thread, body }
}

function formatResult({ result }: { result: MonitorActionResult<MonitorConfig> }): string {
  if (result.start === undefined) return result.text
  const { config, announcement } = result.start
  const replyPrefix = config.ignoreCommentTag ?? "<!-- pr-monitor:reply -->"
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
    `Readiness is managed automatically; agent-authored GitHub replies must begin with \`${replyPrefix}\`. ` +
    "Use mark_ready when new feedback is non-actionable and no reply should be posted. " +
    "Do not schedule delays, polling loops, repeated CI checks, or routine status/flush calls while waiting. " +
    "The monitor stops on merge/close and does not survive an OpenCode restart."
  )
}

export function createPrMonitorPlugin({ runGh }: { runGh: GhRunner }): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const sessions = new Map<string, MonitorSession<MonitorConfig>>()
      // Promise plugins have no host logger; stderr reaches OpenCode's output with --print-logs.
      const log = (message: string): void => console.error(`[pr-monitor] ${message}`)
      const { directory, project } = ctx.location
      const configPaths = [...new Set([
        join(directory, ".pr-monitor.json"),
        join(project.directory, ".pr-monitor.json"),
        join(directory, ".opencode", "pr-monitor.json"),
        join(project.directory, ".opencode", "pr-monitor.json"),
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

      // A user prompt in the owning session: steers a busy turn and starts one
      // when idle, using the session's own agent and model. It resolves after
      // durable inbox admission and rejects on server errors.
      const deliver = async ({ sessionID, report }: { sessionID: string; report: string }): Promise<void> => {
        await ctx.session.prompt({ sessionID, text: report })
      }

      // Plugin cleanup runs while OpenCode holds plugin activation, and prompt
      // admission waits for activation. Unload notices therefore use a durable
      // synthetic message that does not wait and does not start a model turn.
      const persist = async ({ sessionID, report }: { sessionID: string; report: string }): Promise<void> => {
        await ctx.session.synthetic({ sessionID, text: report, description: report, resume: false })
      }

      const skill = await readPackagedSkill({
        path: join(packageSkillDirectory({ moduleUrl: import.meta.url }), "monitor-pr", "SKILL.md"),
      })
      await ctx.skill.transform((editor) => {
        editor.add(
          Skill.Info.make({
            id: Skill.ID.make(skill.id),
            name: Skill.Name.make(skill.name),
            description: skill.description,
            path: Skill.Info.fields.path.make(skill.path),
            content: skill.content,
          }),
        )
      })

      await ctx.tool.transform((editor) => {
        editor.add({
          name: TOOL_NAME,
          options: { codemode: false },
          description: buildMonitorToolDescription({
            delivery: "reports are pushed into THIS session as '[PR Monitor]' messages.",
            configPath: ".pr-monitor.json (falling back to .opencode/pr-monitor.json)",
            lifecycle: "Monitors are per-session and do not survive OpenCode restarts or plugin reloads.",
            waiting: "After start, end the turn whenever there is no delivered report to handle.",
          }),
          input: TOOL_INPUT_SCHEMA,
          execute: async (input, context) => {
            const args = parseToolInput({ input })
            const sessionID = context.sessionID
            const result = await getSession({ sessionID }).execute({
              action: args.action,
              pr: args.pr,
              autoMerge: args.autoMerge,
              thread: args.thread,
              body: args.body,
              start:
                args.action === MonitorAction.start
                  ? {
                      announcementMode: InitialAnnouncementMode.background,
                      createChannel: () => ({
                        deliver: ({ report }) => deliver({ sessionID, report }),
                        persist: ({ report }) => persist({ sessionID, report }),
                      }),
                    }
                  : undefined,
            })
            return { content: formatResult({ result }) }
          },
        })
      })

      const forget = async ({ sessionID }: { sessionID: string }): Promise<void> => {
        const session = sessions.get(sessionID)
        if (session === undefined) return
        sessions.delete(sessionID)
        await session.stopAll({})
      }

      const events = new AbortController()
      void (async () => {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type === "session.deleted") await forget({ sessionID: event.data.sessionID })
        }
      })().catch((error: unknown) => {
        if (!events.signal.aborted) log(`event subscription failed: ${error}`)
      })

      return async () => {
        events.abort()
        const active = [...sessions.values()]
        sessions.clear()
        await Promise.all(
          active.map((session) => session.stopAll({ notice: UNLOAD_NOTICE, channel: StopNoticeChannel.persistent })),
        )
      }
    },
  })
}
