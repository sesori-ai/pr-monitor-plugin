// Report spool shared with hooks/drain-spool.mjs: the MCP server writes one
// file per report under `~/.claude/pr-monitor/spool/<claude pid>/`; the hook
// scripts running under the same Claude Code process drain them into the
// conversation. The path scheme and file protocol (write `.tmp`, rename to
// `.md`; hooks only read `.md`; owner token in `owner`) must stay in sync with
// hooks/drain-spool.mjs, which is dependency-free and cannot import this
// module.

import { execFile, execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const SPOOL_ROOT = join(homedir(), ".claude", "pr-monitor", "spool")

/** Owner-token file inside a spool dir; see `startToken`. */
export const OWNER_FILE = "owner"

export function spoolDirFor(claudePid: number): string {
  return join(SPOOL_ROOT, String(claudePid))
}

let seq = 0

/**
 * Identity of a *process*, not just its pid: pids are recycled by the OS, so
 * `spool/<pid>` alone cannot distinguish this Claude Code process from a dead
 * predecessor that happened to hold the same number — and mistaking the two
 * would inject a stale session's undrained reports into an unrelated
 * conversation. The start time pins it: pid + start time is unique for as long
 * as the machine is up.
 *
 * Linux answers from `/proc` in clock ticks since boot, with no subprocess.
 * macOS has no finer-grained source reachable without native code, so `ps
 * -o lstart=` it is — 1-second resolution, which bounds the guarantee: a pid
 * recycled *and* re-started inside the same second as its predecessor still
 * compares equal. That residue is accepted deliberately. It is orders of
 * magnitude smaller than the hole it closes (which needs no timing
 * coincidence at all, only a dir outliving its owner), and the alternative —
 * calling macOS unverifiable — would restore pid-only routing there, which is
 * strictly worse than a token that is merely coarse.
 *
 * Returns undefined where neither source works, and every caller treats that
 * as "cannot verify" and falls back to pid-only behaviour.
 */
export function startToken(pid: number): string | undefined {
  try {
    // Field 22 of /proc/<pid>/stat. Parsed from the last ')' because field 2
    // is the executable name and may itself contain spaces and parens.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const starttime = after[19]
    if (starttime !== undefined && /^\d+$/.test(starttime)) return `p${starttime}`
  } catch {
    // not Linux, or the process is gone -> try ps
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (out.length > 0) return `s${out}`
  } catch {
    // no usable ps (slim containers) -> unverifiable
  }
  return undefined
}

/**
 * The token this server successfully claimed, and the pid it claimed it for.
 * Set only once the `owner` file is on disk, so a failed claim leaves the
 * write guard disabled rather than blocking every report.
 */
let claimed: { pid: number; token: string } | undefined

/**
 * Take ownership of this session's spool dir at server startup. Must run
 * before anything is spooled or drained, so that a dir carrying `.md` files
 * always carries the token of the process those reports belong to.
 *
 * Anything already in the dir that this process cannot prove it inherited is
 * discarded — both a token from a *different* process that held the same pid,
 * and (just as important) a dir with no token at all, which is unverifiable by
 * definition: leaving those reports in place and then stamping them with this
 * process's token would launder a vanished session's reports into looking like
 * ours. Nothing of ours can be lost here, because at startup this session has
 * not spooled anything yet. An /mcp restart is unaffected: the token is the
 * *Claude Code* process's start time, so a new server under the same live
 * session re-claims its own dir and its undrained reports survive.
 *
 * Never throws: an unwritable spool is diagnosed by `probeSpool` when a
 * monitor actually starts, where the error can be reported to the caller.
 */
export function claimSpool(claudePid: number): void {
  const dir = spoolDirFor(claudePid)
  const token = startToken(claudePid)
  if (token === undefined) return // cannot verify -> leave the dir as it is
  let previous: string | undefined
  try {
    previous = readFileSync(join(dir, OWNER_FILE), "utf8")
  } catch {
    // absent (fresh dir, or one left unclaimed) -> `previous` stays undefined
  }
  if (previous !== token) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; the hook independently refuses dirs it cannot verify
    }
  }
  try {
    mkdirSync(dir, { recursive: true })
    // tmp + rename: the hook reads this path concurrently, and a truncated
    // read must never be mistaken for a foreign token.
    const tmp = join(dir, `.${OWNER_FILE}.${process.pid}.tmp`)
    writeFileSync(tmp, token, "utf8")
    renameSync(tmp, join(dir, OWNER_FILE))
    claimed = { pid: claudePid, token }
  } catch {
    // best-effort: without the token the hook falls back to pid-only routing
  }
}

/**
 * Refuse to write into a spool this server no longer owns.
 *
 * `claimSpool` proves ownership once, at startup, but the pid in the path is
 * still just a number: if this server outlives its Claude Code parent (a
 * shutdown notice queued while the process is exiting) and the OS hands that
 * pid to a *new* Claude Code process, the path would resolve to the newcomer's
 * spool — and its fresh owner token would make the hook accept our stale
 * report as the new session's own. Re-reading the token before each write
 * keeps "a server writes only into the dir it claimed" true for the whole
 * process lifetime, not just at startup.
 */
/**
 * The non-throwing form of the check `spoolReport` makes, for writers that
 * should simply go quiet rather than surface an error (session-state.ts).
 */
export function ownsSpool(claudePid: number): boolean {
  try {
    assertOwned(claudePid, spoolDirFor(claudePid))
    return true
  } catch {
    return false
  }
}

function assertOwned(claudePid: number, dir: string): void {
  if (claimed === undefined || claimed.pid !== claudePid) return // unverifiable -> pid-only, as before
  let current: string | undefined
  try {
    current = readFileSync(join(dir, OWNER_FILE), "utf8")
  } catch {
    current = undefined
  }
  if (current === claimed.token) return
  throw new Error(
    `spool ${dir} is no longer owned by this server (the Claude Code process it belonged to is gone); refusing to write`,
  )
}

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

/**
 * Write one report file atomically (tmp + rename) so hooks never read a
 * partial file.
 *
 * The name carries this server's own pid as well as `seq`, because `seq`
 * restarts at 0 in every process while the spool dir outlives them: two MCP
 * servers writing the same dir (an /mcp restart, where the outgoing server
 * still spools its shutdown notices as the incoming one starts) would
 * otherwise collide on both the `.tmp` and the `.md` name within the same
 * millisecond and silently lose a report. The millisecond stays the leading,
 * fixed-width component so the hook's lexicographic sort remains chronological.
 */
export function spoolReport(claudePid: number, report: string): void {
  const dir = spoolDirFor(claudePid)
  mkdirSync(dir, { recursive: true })
  assertOwned(claudePid, dir)
  seq += 1
  const name = `${Date.now()}-${process.pid}-${String(seq).padStart(4, "0")}`
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
