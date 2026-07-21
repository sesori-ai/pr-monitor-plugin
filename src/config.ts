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
}

const DEFAULT_CONFIG: MonitorConfig = {
  debounceMinutes: 5,
  maxCiWaitMinutes: 30,
  pollIntervalSeconds: 60,
  ignoreCommentTag: undefined,
  announceOnStart: true,
  desktopNotifications: false,
}

const MIN_POLL_INTERVAL_SECONDS = 30

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
  cfg.pollIntervalSeconds = Math.max(poll, MIN_POLL_INTERVAL_SECONDS)
  const tag = record["ignoreCommentTag"]
  cfg.ignoreCommentTag = typeof tag === "string" && tag.length > 0 ? tag : undefined
  const announce = record["announceOnStart"]
  if (typeof announce === "boolean") cfg.announceOnStart = announce
  const notify = record["desktopNotifications"]
  if (typeof notify === "boolean") cfg.desktopNotifications = notify
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
