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
// pid, and matching the `owner` token the server wrote there (a pid alone is
// not an identity — the OS recycles them). Codex is the same shape: its plugin
// hooks and MCP servers are children of the Codex TUI process, hooks via a
// shell (verified on 0.153). The walk deliberately stops at the
// grandparent — a full ancestry walk would reach an OUTER Claude Code session
// when sessions nest (session A's Bash tool runs `claude -p ...` → session B),
// letting B's hooks steal A's reports. Ancestry comes from /proc where it
// exists and `ps` otherwise; with neither it is unknown, and this hook then
// drains nothing rather than guess — an undelivered report waits on disk and
// arrives later, while one delivered to the wrong session is unlinked and gone
// from the conversation that owned it.

import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const SPOOL_ROOT = join(homedir(), ".claude", "pr-monitor", "spool")
const OWNER_FILE = "owner"
// Resolved from this file rather than CLAUDE_PLUGIN_ROOT: the waiter path ends
// up inside a command the model runs, and must be correct however the hook was
// invoked.
const WAITER = join(dirname(fileURLToPath(import.meta.url)), "await-activity.mjs")
const WAIT_SECONDS = 540
const MAX_BLOCKS_WITHOUT_WAIT = 5
const KEEPALIVE_MARKER = ".keepalive"
const WAITER_MARKER = ".waiter" // written by await-activity.mjs when a wait completes

/**
 * Single-quote a path for a shell command line. The waiter path is interpolated
 * into a Bash command the model runs, and a plugin can be installed under any
 * path the user chooses — inside double quotes a `$(...)`, backtick or `$VAR`
 * in that path would be expanded by the shell before node ever starts.
 */
const shellQuote = (value) => `'${value.replace(/'/g, `'\\''`)}'`

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
 * the header comment for why the walk is capped at the grandparent.
 *
 * When the grandparent cannot be resolved the set simply lacks it, and since
 * spool dirs are named by the Claude Code pid, nothing matches and nothing is
 * drained. That is the intended outcome: the number of live spools on the
 * machine says nothing about which of them belongs to the session running this
 * hook — a session with no monitor at all can fire hooks — so there is no
 * cardinality trick that could stand in for real ancestry.
 */
function candidatePids() {
  const pids = new Set([process.pid, process.ppid])
  const gpid = parentOf(process.ppid)
  if (gpid !== undefined && gpid > 1) pids.add(gpid)
  return pids
}

/**
 * Spool dirs this session may read: live pids matching `candidatePids()` whose
 * `owner` token still matches the process holding them. Dead-pid dirs are GC'd
 * on the way past — any session may collect those — while a live pid whose
 * token mismatches is only skipped, never deleted (see below).
 * Returns `[{ pid, dir }]`.
 */
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
      try {
        rmSync(join(SPOOL_ROOT, entry), { recursive: true, force: true })
      } catch {}
      continue
    }
    live.push({ pid, dir: join(SPOOL_ROOT, entry) })
  }

  const candidates = candidatePids()
  // Skipped, never deleted: a mismatch here means the pid was recycled, and the
  // server now holding it is concurrently claiming this dir (claimSpool wipes
  // and recreates it at startup). Deleting would race that claim and could take
  // the new session's first reports with it. Refusing to read is all this hook
  // needs; cleanup belongs to the claim, which runs before the server accepts
  // work, and to the dead-pid sweep above.
  return live.filter(({ pid, dir }) => candidates.has(pid) && ownerMatches(pid, dir))
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
 * Guard against a tight Stop loop, counted in *blocks that produced no wait*
 * rather than elapsed time.
 *
 * A wall-clock gap cannot tell the two failure modes apart: a session that runs
 * a quick tool and then ends its turn again looks exactly like one spinning
 * because the waiter never starts (node missing, script unreadable, model
 * ignoring the instruction) — and treating the first as the second abandons a
 * PR that is still being worked. So the waiter itself reports in (`.waiter`),
 * and any block it ran through resets the streak. Only a run of blocks with no
 * wait at all between them gives up, bounding a genuine spin at a handful of
 * round trips instead of never letting go. Both markers live in the spool dir
 * and die with it.
 */
function keepAliveBlockAllowed(pid) {
  const dir = join(SPOOL_ROOT, String(pid))
  const readStamp = (path) => {
    try {
      const value = Number(readFileSync(path, "utf8"))
      return Number.isFinite(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  let previous
  try {
    previous = JSON.parse(readFileSync(join(dir, KEEPALIVE_MARKER), "utf8"))
  } catch {
    // no marker yet -> first block of this loop
  }
  const lastBlockAt = Number(previous?.at)
  const waitedAt = readStamp(join(dir, WAITER_MARKER))
  // The waiter having finished since the last block is proof the loop is doing
  // what it was told, however briefly.
  const streak =
    waitedAt !== undefined && Number.isFinite(lastBlockAt) && waitedAt > lastBlockAt ? 0 : Number(previous?.streak) || 0
  if (streak >= MAX_BLOCKS_WITHOUT_WAIT) return false
  try {
    writeFileSync(join(dir, KEEPALIVE_MARKER), JSON.stringify({ at: Date.now(), streak: streak + 1 }), "utf8")
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

  // Codex runs the waiter inside its sandbox, where the spool dir is read-only
  // and the waiter cannot leave its own `.waiter` proof; this hook runs outside
  // it, so the PostToolUse that follows the waiter's exit stamps on its behalf.
  // Only a *completed* wait counts: the waiter always ends by printing a
  // `pr-monitor:` line, while a missing node or unreadable script prints none —
  // stamping on the command alone would let a broken waiter reset the Stop
  // guard's streak and reopen the unbounded loop it bounds.
  if (
    event === "PostToolUse" &&
    JSON.stringify(input.tool_input ?? "").includes("await-activity.mjs") &&
    JSON.stringify(input.tool_response ?? "").includes("pr-monitor:")
  ) {
    for (const { dir } of spools) {
      try {
        writeFileSync(join(dir, WAITER_MARKER), String(Date.now()), "utf8")
      } catch {}
    }
  }

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
    "2. You inspected the latest activity and it is non-actionable (for example, a bot acknowledgement that " +
      "should not receive another reply): call `pr_monitor` with action `mark_ready` to accept the current state " +
      "manually.",
    "3. Nothing to do right now: automatic readiness is waiting for CI, prefixed replies, or its quiet window. " +
      "Wait for the next report by running this with your shell tool and a 600000 ms timeout " +
      "(Claude Code Bash: `timeout: 600000`; Codex shell: `timeout_ms: 600000`):",
    "",
    `   node ${shellQuote(WAITER)} --session ${pid} --timeout ${WAIT_SECONDS}`,
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
