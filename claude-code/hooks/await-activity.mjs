#!/usr/bin/env node
// pr-monitor keep-alive waiter. Unlike the other script in this directory this
// is NOT a hook: the Stop hook (drain-spool.mjs) hands the session a Bash
// command that runs this file, and it blocks until there is something to do.
//
// Why a blocking child process rather than the session polling in a loop: a
// `sleep 60`-style loop costs a model round trip per minute of waiting and
// wakes the session up to learn nothing. This blocks for as long as the PR is
// quiet, then exits the moment a report lands — one round trip per real event.
// Claude Code fires PostToolUse when this exits, and that drains the spool, so
// this script deliberately never reads or deletes reports itself: it only
// detects that one exists. Exactly-once delivery stays with the drain hook.
//
// Always exits 0 — a waiting aid must never fail a turn. Interrupting the Bash
// call (Esc) kills it like any other command, which is the intended escape.
//
// Path scheme is shared with claude/spool.ts and claude/session-state.ts and
// must stay in sync with them; dependency-free (node builtins only) because
// plugin installs run no npm install.

import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SPOOL_ROOT = join(homedir(), ".claude", "pr-monitor", "spool")
const POLL_MS = 2000
const DEFAULT_TIMEOUT_SECONDS = 540

function parseArgs(argv) {
  const args = { session: undefined, timeout: DEFAULT_TIMEOUT_SECONDS }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1]
    if (argv[i] === "--session" && value !== undefined) {
      const pid = Number(value)
      if (Number.isInteger(pid) && pid > 0) args.session = pid
      i += 1
    } else if (argv[i] === "--timeout" && value !== undefined) {
      const seconds = Number(value)
      if (Number.isFinite(seconds) && seconds > 0) args.timeout = seconds
      i += 1
    }
  }
  return args
}

function hasPendingReport(dir) {
  try {
    return readdirSync(dir).some((name) => name.endsWith(".md"))
  } catch {
    return false // no spool dir yet -> nothing pending
  }
}

function readState(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"))
    return parsed?.version === 1 ? parsed : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const { session, timeout } = parseArgs(process.argv.slice(2))
  if (session === undefined) {
    console.log("pr-monitor: no --session pid given, nothing to wait for.")
    return
  }
  const dir = join(SPOOL_ROOT, String(session))
  const deadline = Date.now() + timeout * 1000

  for (;;) {
    if (hasPendingReport(dir)) {
      console.log("pr-monitor: a [PR Monitor] report is waiting — it is injected right after this command returns.")
      return
    }
    const state = readState(dir)
    if (state === undefined) {
      console.log("pr-monitor: this session has no active monitor state; nothing left to wait for.")
      return
    }
    const now = Date.now()
    if (!state.keepAlive) {
      console.log("pr-monitor: monitoring no longer needs this session (all monitors stopped or handed off for human review).")
      return
    }
    if (now > state.expiresAtMs) {
      console.log("pr-monitor: the monitor process is no longer refreshing its state (MCP server stopped). Re-start monitoring if still needed.")
      return
    }
    if (now > state.keepAliveUntilMs) {
      console.log("pr-monitor: idle limit reached with no PR activity (keepAliveMaxMinutes). Not waiting further.")
      return
    }
    if (now >= deadline) {
      const waited = timeout < 90 ? `${Math.round(timeout)}s` : `${Math.round(timeout / 60)}m`
      const watching = Array.isArray(state.monitors) && state.monitors.length > 0 ? ` Still watching: ${state.monitors.join(", ")}.` : ""
      console.log(`pr-monitor: no PR activity in the last ${waited}.${watching}`)
      return
    }
    await sleep(Math.min(POLL_MS, Math.max(deadline - now, 1)))
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("pr-monitor: wait interrupted.")
    process.exit(0)
  })
}

try {
  await main()
} catch (error) {
  console.log(`pr-monitor: wait ended early (${error?.message ?? error}).`)
}
