// Monitor tuning, loaded from the first readable `pr-monitor.json` among the
// candidate paths the host shell passes in (opencode: `.opencode/` in the
// project directory then worktree; Claude Code: `.claude/` then `.opencode/`
// in the project directory), falling back to defaults.

import { readFile } from "node:fs/promises"

export type MonitorConfig = {
  debounceMinutes: number
  maxCiWaitMinutes: number
  pollIntervalSeconds: number
  ignoreCommentTag: string | undefined
  announceOnStart: boolean
  // Claude Code shell only (delivery there is passive — reports are injected at
  // the next hook event, so an idle session learns nothing until then; an OS
  // notification closes that gap). The opencode shell ignores it.
  desktopNotifications: boolean
  // Label the mark_ready action applies to a PR on GitHub.
  readyLabel: string
  // Claude Code shell only. While a monitored PR has not been handed off to a
  // human (mark_ready), the Stop hook refuses turn-end and points the session
  // at the waiter script, so a report that lands while the session is idle is
  // still acted on. Without it delivery is passive: reports wait on disk until
  // the user types. The opencode shell ignores both keys — there the plugin
  // pushes a real message into the session instead.
  keepAlive: boolean
  // Upper bound on how long the keep-alive loop may hold a session, refreshed
  // on every delivered report (so it bounds *idle* time, not total work time).
  keepAliveMaxMinutes: number
}

const DEFAULT_CONFIG: MonitorConfig = {
  debounceMinutes: 5,
  maxCiWaitMinutes: 30,
  pollIntervalSeconds: 60,
  ignoreCommentTag: undefined,
  announceOnStart: true,
  desktopNotifications: false,
  readyLabel: "ready-for-human-review",
  keepAlive: true,
  keepAliveMaxMinutes: 120,
}

const MIN_POLL_INTERVAL_SECONDS = 30
// The interval is handed to setInterval as milliseconds, and Node silently
// coerces any delay past 2^31-1 ms to *1 ms* — so a value meant to slow polling
// down (a milliseconds-style `3000000`, say) would instead spawn `gh` in a
// tight loop. Cap it well short of that overflow; a day is longer than any
// plausible poll interval for a PR that is actively being worked on.
const MAX_POLL_INTERVAL_SECONDS = 86_400

function resolveConfig(raw: unknown): MonitorConfig {
  const cfg = { ...DEFAULT_CONFIG }
  if (typeof raw !== "object" || raw === null) return cfg
  const record = raw as Record<string, unknown>
  const num = (key: string): number | undefined => {
    const value = record[key]
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  }
  cfg.debounceMinutes = num("debounceMinutes") ?? cfg.debounceMinutes
  cfg.maxCiWaitMinutes = num("maxCiWaitMinutes") ?? cfg.maxCiWaitMinutes
  const poll = num("pollIntervalSeconds") ?? cfg.pollIntervalSeconds
  cfg.pollIntervalSeconds = Math.min(Math.max(poll, MIN_POLL_INTERVAL_SECONDS), MAX_POLL_INTERVAL_SECONDS)
  const tag = record["ignoreCommentTag"]
  cfg.ignoreCommentTag = typeof tag === "string" && tag.length > 0 ? tag : undefined
  const announce = record["announceOnStart"]
  if (typeof announce === "boolean") cfg.announceOnStart = announce
  const notify = record["desktopNotifications"]
  if (typeof notify === "boolean") cfg.desktopNotifications = notify
  const label = record["readyLabel"]
  if (typeof label === "string" && label.length > 0) cfg.readyLabel = label
  const keepAlive = record["keepAlive"]
  if (typeof keepAlive === "boolean") cfg.keepAlive = keepAlive
  cfg.keepAliveMaxMinutes = num("keepAliveMaxMinutes") ?? cfg.keepAliveMaxMinutes
  return cfg
}

export async function loadConfig(paths: string[], log: (message: string) => void): Promise<MonitorConfig> {
  for (const path of paths) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue // missing/unreadable file at this path -> try next, else defaults
    }
    try {
      return resolveConfig(JSON.parse(text))
    } catch (error) {
      log(`config file ${path} is not valid JSON, ignoring it: ${(error as Error).message}`)
    }
  }
  return resolveConfig(undefined)
}
