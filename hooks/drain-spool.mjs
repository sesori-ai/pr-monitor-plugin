#!/usr/bin/env node
// pr-monitor hook: drain spooled [PR Monitor] reports written by this
// session's MCP server (see claude/spool.ts for the path scheme and file
// protocol) and inject them into the conversation. Wired to UserPromptSubmit,
// PostToolUse, and Stop in hooks/hooks.json; the hook event determines the
// output shape.
//
// On Stop it also runs the keep-alive loop: while this session owns a monitor
// whose PR has not been handed off to a human, turn-end is refused and the
// session is pointed at await-activity.mjs, which blocks until the next report
// lands. Without it, delivery is passive — a report arriving while the session
// sits idle waits on disk until the user happens to type. State comes from the
// MCP server via claude/session-state.ts; see that file for the deadlines.
//
// Dependency-free on purpose: plugin installs do not run npm install, and this
// script runs on hook events, so it must start fast and exit 0 silently in
// every doubtful case — a monitoring aid must never break the session.
//
// Spool routing: spool dirs are named after the Claude Code process pid that
// owns them (the MCP server's parent). Claude Code runs hook commands via
// `sh -c`, so this process's parent is that sh and its grandparent is the
// Claude Code process: "my spool" = the dir named by my parent or grandparent
// pid. The walk deliberately stops there — a full ancestry walk would reach an
// OUTER Claude Code session when sessions nest (session A's Bash tool runs
// `claude -p ...` → session B), letting B's hooks steal A's reports. If `ps`
// is unusable (e.g. no procps in slim containers), fall back to draining every
// live-pid spool — correct whenever a single Claude Code session is using
// pr-monitor at a time.

import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SPOOL_ROOT = join(homedir(), ".claude", "pr-monitor", "spool")
// Resolved from this file rather than CLAUDE_PLUGIN_ROOT: the waiter path ends
// up inside a command the model runs, and must be correct however the hook was
// invoked.
const WAITER = join(dirname(fileURLToPath(import.meta.url)), "await-activity.mjs")
const WAIT_SECONDS = 540
const MIN_KEEPALIVE_BLOCK_GAP_MS = 30_000
const KEEPALIVE_MARKER = ".keepalive"

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
 * Pids that may own this session's spool: this process, its parent (the sh
 * running the hook command), and its grandparent (the Claude Code process —
 * or, should a future version spawn hooks without a shell, the parent). See
 * the header comment for why the walk is capped at the grandparent. Returns
 * undefined if `ps` is unusable, engaging the drain-all-live-spools fallback.
 */
function candidatePids() {
  const pids = new Set([process.pid, process.ppid])
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" })
    const gpid = Number(out.trim())
    if (Number.isInteger(gpid) && gpid > 1) pids.add(gpid)
    return pids
  } catch {
    return undefined
  }
}

/**
 * Spool dirs this session may read: live pids matching `candidatePids()`, or —
 * when `ps` is unusable — every live pid. Dead-pid dirs are GC'd on the way
 * past (stale spools from crashed Claude Code processes; any session may
 * collect them). Returns `[{ pid, dir }]`.
 */
function ownedSpools() {
  let entries
  try {
    entries = readdirSync(SPOOL_ROOT)
  } catch {
    return [] // no spool -> pr-monitor has never delivered anything
  }
  const candidates = candidatePids()
  const owned = []
  for (const entry of entries) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!isAlive(pid)) {
      try {
        rmSync(join(SPOOL_ROOT, entry), { recursive: true, force: true })
      } catch {}
      continue
    }
    if (candidates !== undefined && !candidates.has(pid)) continue // another session's spool
    owned.push({ pid, dir: join(SPOOL_ROOT, entry) })
  }
  return owned
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
    let claimed = 0
    for (const name of files) {
      const path = join(dir, name)
      try {
        const content = readFileSync(path, "utf8")
        // The unlink is the exactly-once claim: concurrent drains (parallel
        // tool calls fire parallel PostToolUse hooks) can both read a file,
        // but only the one whose unlink succeeds may emit it.
        unlinkSync(path)
        reports.push(content)
        claimed += 1
      } catch {}
    }
    // A delivered report is proof the loop is making progress, so the
    // rate-limit guard below must not count the block that preceded it —
    // otherwise handling a report in under 30s would suppress the next
    // legitimate keep-alive block and drop the session out of the loop.
    if (claimed > 0) {
      try {
        unlinkSync(join(dir, KEEPALIVE_MARKER))
      } catch {}
    }
  }
  return reports
}

/**
 * The first owned spool whose keep-alive state is armed and unexpired, as
 * `{ pid, monitors }`. Both deadlines are honoured here: `expiresAtMs` (the
 * MCP server stopped refreshing — its state must not hold the session) and
 * `keepAliveUntilMs` (nothing has happened on the PR for too long).
 */
function armedKeepAlive(spools) {
  const now = Date.now()
  for (const { pid, dir } of spools) {
    let state
    try {
      state = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"))
    } catch {
      continue // no state file -> this session is not running the loop
    }
    if (state?.version !== 1 || !state.keepAlive) continue
    if (!(now < state.expiresAtMs) || !(now < state.keepAliveUntilMs)) continue
    return { pid, monitors: Array.isArray(state.monitors) ? state.monitors : [] }
  }
  return undefined
}

/**
 * Rate-limit guard against a tight Stop loop. The normal cycle is paced by the
 * waiter blocking for minutes, so consecutive report-less keep-alive blocks
 * seconds apart mean the waiter is not actually running (node missing, script
 * unreadable, model ignoring the instruction). Let the turn end instead of
 * spinning; the marker lives in the spool dir and dies with it.
 */
function keepAliveBlockAllowed(pid) {
  const marker = join(SPOOL_ROOT, String(pid), KEEPALIVE_MARKER)
  const now = Date.now()
  try {
    const previous = Number(readFileSync(marker, "utf8"))
    if (Number.isFinite(previous) && now - previous < MIN_KEEPALIVE_BLOCK_GAP_MS) return false
  } catch {
    // no marker yet -> first block of this loop
  }
  try {
    writeFileSync(marker, String(now), "utf8")
  } catch {
    // If the marker cannot be written the guard degrades to "always allow";
    // the state-file deadlines still bound the loop.
  }
  return true
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

  const spools = ownedSpools()
  const reports = drainReports(spools)
  const text = reports.join("\n\n")

  if (event === "Stop") {
    if (reports.length > 0) {
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
    // Nothing to deliver, but the PR is still this session's job: refuse
    // turn-end so the session waits for the next report instead of going idle.
    const armed = armedKeepAlive(spools)
    if (armed !== undefined && keepAliveBlockAllowed(armed.pid)) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: keepAliveReason(armed) }))
    }
    return
  }

  if (reports.length === 0) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: text,
      },
    }),
  )
}

/**
 * The Stop-block message that drives the loop. It has to be self-contained:
 * it is the only thing standing between an idle session and a PR nobody
 * finishes, and it may be read in a context where the monitor-pr skill is not
 * loaded.
 */
function keepAliveReason({ pid, monitors }) {
  const watching = monitors.length > 0 ? monitors.join(", ") : "this session's PR(s)"
  return [
    `[PR Monitor keep-alive] Still monitoring ${watching}, and it has not been handed off for human review yet — the work is not finished, so do not end the turn.`,
    "",
    "Pick the first that applies:",
    "",
    "1. Outstanding PR work you already know about (unaddressed review comments, failing CI, merge conflicts): do it now. Follow the monitor-pr skill; use the address-pr-comments skill for review threads.",
    "2. The PR is finished — CI passing, no unresolved review threads, no pending/requested reviewers left, no outstanding changes_requested, and mergeable: call `pr_monitor` with action `mark_ready`. That is the handoff and it ends this loop.",
    "3. Nothing to do right now: wait for the next report by running this with the Bash tool, passing `timeout: 600000`:",
    "",
    `   node ${JSON.stringify(WAITER)} --session ${pid} --timeout ${WAIT_SECONDS}`,
    "",
    "   It blocks until a [PR Monitor] report lands (the report is then injected automatically), until monitoring finishes, or until it times out — then reassess. Waiting is the expected state; a quiet PR is not a reason to finish.",
    "",
    "If the user asked you to stop monitoring, or wants your attention elsewhere, call `pr_monitor` with action `stop` (pr `all`) and answer them instead.",
  ].join("\n")
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
