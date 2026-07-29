// Report spool shared with hooks/drain-spool.mjs: the MCP server writes one
// file per report under `~/.claude/pr-monitor/spool/<claude pid>/`; the hook
// scripts running under the same Claude Code process drain them into the
// conversation. The path scheme and file protocol (write `.tmp`, rename to
// `.md`; hooks only read `.md`) must stay in sync with hooks/drain-spool.mjs,
// which is dependency-free and cannot import this module.

import { execFile } from "node:child_process"
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const SPOOL_ROOT = join(homedir(), ".claude", "pr-monitor", "spool")

export function spoolDirFor(claudePid: number): string {
  return join(SPOOL_ROOT, String(claudePid))
}

let seq = 0

/**
 * Throw if the spool is not writable. The spool is the only delivery channel
 * and later write failures are swallowed into stderr logs (deliverOrLog), so
 * an unwritable spool must be surfaced before a monitor starts claiming that
 * reports will arrive.
 */
export function probeSpool(claudePid: number): void {
  const dir = spoolDirFor(claudePid)
  mkdirSync(dir, { recursive: true })
  const probe = join(dir, `.probe-${process.pid}`)
  writeFileSync(probe, "", "utf8")
  rmSync(probe, { force: true })
}

/** Write one report file atomically (tmp + rename) so hooks never read a partial file. */
export function spoolReport(claudePid: number, report: string): void {
  const dir = spoolDirFor(claudePid)
  mkdirSync(dir, { recursive: true })
  seq += 1
  const name = `${Date.now()}-${String(seq).padStart(4, "0")}`
  const tmp = join(dir, `${name}.tmp`)
  writeFileSync(tmp, report, "utf8")
  renameSync(tmp, join(dir, `${name}.md`))
}

/**
 * Remove spool dirs left behind by Claude Code processes that no longer
 * exist (crashes, sessions that ended with undrained reports). Never touches
 * the live process's own dir: reports spooled by a previous MCP server
 * instance of the same session (e.g. before an /mcp restart) must survive to
 * be drained.
 */
export function collectDeadSpools(selfClaudePid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(SPOOL_ROOT)
  } catch {
    return
  }
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (pid === selfClaudePid || isAlive(pid)) continue
    try {
      rmSync(join(SPOOL_ROOT, entry), { recursive: true, force: true })
    } catch {
      // best-effort GC
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Best-effort OS notification (macOS/Linux only). Never throws. */
export function notifyDesktop(title: string, body: string): void {
  const swallow = () => {}
  if (process.platform === "darwin") {
    const esc = (text: string) => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], swallow)
  } else if (process.platform === "linux") {
    execFile("notify-send", [title, body], swallow)
  }
}
