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
// pid. The walk deliberately stops there — a full ancestry walk would reach an
// OUTER Claude Code session when sessions nest (session A's Bash tool runs
// `claude -p ...` → session B), letting B's hooks steal A's reports. If `ps`
// is unusable (e.g. no procps in slim containers), fall back to draining every
// live-pid spool — correct whenever a single Claude Code session is using
// pr-monitor at a time.

import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SPOOL_ROOT = join(homedir(), ".claude", "pr-monitor", "spool")

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

function drainReports() {
  let entries
  try {
    entries = readdirSync(SPOOL_ROOT)
  } catch {
    return [] // no spool -> pr-monitor has never delivered anything
  }
  if (entries.length === 0) return []

  const candidates = candidatePids()
  const reports = []
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
    if (candidates !== undefined && !candidates.has(pid)) continue // another session's spool
    const dir = join(SPOOL_ROOT, entry)
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

  const reports = drainReports()
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
