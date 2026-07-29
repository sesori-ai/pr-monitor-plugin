#!/usr/bin/env node
// pr-monitor hook: drain spooled [PR Monitor] reports written by this
// session's MCP server (see claude/spool.ts for the path scheme and file
// protocol) and inject them into the conversation. Wired to UserPromptSubmit,
// PostToolUse, and Stop in hooks/hooks.json; the hook event determines the
// output shape.
//
// Dependency-free on purpose: plugin installs do not run npm install, and this
// script runs on hook events, so it must start fast and exit 0 silently in
// every doubtful case — a monitoring aid must never break the session.
//
// Spool routing: spool dirs are named after the Claude Code process pid that
// owns them (the MCP server's parent). Claude Code runs hook commands via
// `sh -c`, so this process's parent is that sh and its grandparent is the
// Claude Code process: "my spool" = the dir named by my parent or grandparent
// pid, and matching the `owner` token the server wrote there (a pid alone is
// not an identity — the OS recycles them). The walk deliberately stops at the
// grandparent — a full ancestry walk would reach an OUTER Claude Code session
// when sessions nest (session A's Bash tool runs `claude -p ...` → session B),
// letting B's hooks steal A's reports. Ancestry comes from /proc where it
// exists and `ps` otherwise; with neither, a single live spool is still
// unambiguously ours, but two or more are not attributable and are left alone
// — an undelivered report is recoverable, one delivered to the wrong session
// is not.

import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SPOOL_ROOT = join(homedir(), ".claude", "pr-monitor", "spool")
const OWNER_FILE = "owner"

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"))
  } catch {
    return {}
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

/**
 * The parent of `pid`, or undefined when it cannot be determined. /proc is
 * tried first: it needs no subprocess, so on Linux the hook stays exec-free,
 * and it still answers in slim containers that ship no `ps`.
 */
function parentOf(pid) {
  try {
    // Field 4 of /proc/<pid>/stat, read from the last ')' because field 2 is
    // the executable name and may itself contain spaces and parens.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
    if (Number.isInteger(ppid)) return ppid
  } catch {
    // not Linux, or the process is gone -> try ps
  }
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const ppid = Number(out.trim())
    if (Number.isInteger(ppid)) return ppid
  } catch {
    // no usable ps either
  }
  return undefined
}

/**
 * Identity of the process holding `pid` — its start time, mirroring
 * `startToken` in claude-code/src/spool.ts, which must stay in sync. Returns
 * undefined where the platform offers neither source.
 */
function startToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const starttime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] // field 22
    if (starttime !== undefined && /^\d+$/.test(starttime)) return `p${starttime}`
  } catch {}
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (out.length > 0) return `s${out}`
  } catch {}
  return undefined
}

/**
 * Whether `dir` was written by the process that holds `pid` *now*, rather than
 * by a dead predecessor whose pid the OS has since recycled — which would
 * otherwise inject a vanished session's undrained reports into an unrelated
 * conversation. Compares the `owner` token claimSpool wrote (spool.ts).
 * Unverifiable cases answer true: the token guards a rare collision and must
 * not become a precondition for delivering reports at all.
 */
function ownerMatches(pid, dir) {
  let recorded
  try {
    recorded = readFileSync(join(dir, OWNER_FILE), "utf8")
  } catch {
    return true // unclaimed dir: older server, or one that could not write it
  }
  const token = startToken(pid)
  return token === undefined || token === recorded
}

/**
 * Pids that may own this session's spool: this process, its parent (the sh
 * running the hook command), and its grandparent (the Claude Code process —
 * or, should a future version spawn hooks without a shell, the parent). See
 * the header comment for why the walk is capped at the grandparent. Returns
 * undefined when the ancestry is unavailable, engaging the lone-spool fallback.
 */
function candidatePids() {
  const gpid = parentOf(process.ppid)
  if (gpid === undefined) return undefined
  const pids = new Set([process.pid, process.ppid])
  if (gpid > 1) pids.add(gpid)
  return pids
}

/** Spool dirs this session may drain, as `[{ pid, dir }]`. */
function ownedSpools() {
  let entries
  try {
    entries = readdirSync(SPOOL_ROOT)
  } catch {
    return [] // no spool -> pr-monitor has never delivered anything
  }
  const live = []
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!isAlive(pid)) {
      // Stale spool from a dead Claude Code process: any session may GC it.
      try {
        rmSync(join(SPOOL_ROOT, entry), { recursive: true, force: true })
      } catch {}
      continue
    }
    live.push({ pid, dir: join(SPOOL_ROOT, entry) })
  }

  const candidates = candidatePids()
  // Without ancestry, one live spool is unambiguously this session's; several
  // are not attributable, and draining the wrong one deletes reports from the
  // conversation that owns them.
  const mine =
    candidates === undefined ? (live.length === 1 ? live : []) : live.filter(({ pid }) => candidates.has(pid))

  return mine.filter(({ pid, dir }) => {
    if (ownerMatches(pid, dir)) return true
    // Live pid, but the spool predates the process holding it: written by a
    // predecessor that is gone, so no session will ever legitimately drain it.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
    return false
  })
}

function drainReports(spools) {
  const reports = []
  for (const { dir } of spools) {
    let files
    try {
      files = readdirSync(dir)
        .filter((name) => name.endsWith(".md"))
        .sort()
    } catch {
      continue
    }
    for (const name of files) {
      const path = join(dir, name)
      try {
        const content = readFileSync(path, "utf8")
        // The unlink is the exactly-once claim: concurrent drains (parallel
        // tool calls fire parallel PostToolUse hooks) can both read a file,
        // but only the one whose unlink succeeds may emit it.
        unlinkSync(path)
        reports.push(content)
      } catch {}
    }
  }
  return reports
}

function main() {
  const input = readStdinJson()
  const event = input.hook_event_name
  if (event !== "UserPromptSubmit" && event !== "PostToolUse" && event !== "Stop") return
  // PostToolUse also fires for tool calls made inside Task subagents, where
  // injected context reaches only the subagent and the report would be lost to
  // the main conversation. Subagent-context hook inputs carry agent_id
  // (verified empirically on 2.1.216); leave the spool for a main-context event.
  if (input.agent_id) return

  const reports = drainReports(ownedSpools())
  if (reports.length === 0) return
  const text = reports.join("\n\n")

  if (event === "Stop") {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason:
          "New [PR Monitor] report(s) arrived while you were working. If they need action (failing CI, new review " +
          "comments, conflicts), address them now; otherwise surface them briefly to the user before finishing:\n\n" +
          text,
      }),
    )
    return
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: text,
      },
    }),
  )
}

process.stdout.on("error", () => {})
try {
  main()
} catch {
  // Never fail the hook: a monitoring aid must not disturb the session.
}
// No process.exit(0) here: a large batch of reports can exceed the ~64KB pipe
// buffer, and process.exit would discard the unflushed remainder — truncating
// the JSON and losing already-unlinked reports. Natural exit flushes stdout.
