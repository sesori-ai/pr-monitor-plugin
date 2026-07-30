// Keep-alive state shared with hooks/drain-spool.mjs and hooks/await-activity.mjs.
//
// Claude Code has no push channel into a session, so a report that lands while
// the session is idle would simply wait on disk (see spool.ts). The keep-alive
// loop closes that gap: while this session owns a monitor whose PR has not been
// handed off to a human, the Stop hook refuses turn-end and points the session
// at the waiter script, which blocks until the next report is spooled.
//
// Only the MCP server writes this file; the two hook scripts only read it. It
// lives inside the session's spool dir so it shares that dir's lifecycle —
// pid-keyed, and garbage-collected by the same dead-pid sweep. The drain hook
// reads `.md` files exclusively, so a sibling `.json` never looks like a report.
//
// The two independent deadlines are both required:
//   - expiresAtMs     liveness. Refreshed on every poll tick. If the MCP server
//                     dies (crash, /mcp restart) the file stops being refreshed
//                     and the hooks stop honouring it within one poll interval,
//                     instead of holding the session on a state nobody owns.
//   - keepAliveUntilMs idle cap. Refreshed on every delivered report, so it
//                     bounds how long the loop waits with NOTHING happening —
//                     an active PR keeps extending it, a dead one lets go.

import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ownsSpool, spoolDirFor } from "./spool"

export const SESSION_STATE_FILE = "session.json"

export type SessionState = {
  version: 1
  /** Whether the Stop hook should refuse turn-end for this session. */
  keepAlive: boolean
  /** Wall-clock ms after which this file is stale and must be ignored. */
  expiresAtMs: number
  /** Wall-clock ms after which the loop gives up waiting for new activity. */
  keepAliveUntilMs: number
  /** Target keys still awaiting handoff, for the Stop hook's block message. */
  monitors: string[]
}

/**
 * Write the state atomically (tmp + rename) so a reader never sees a partial
 * file.
 *
 * Skipped entirely once this server no longer owns the spool. This is written
 * on every poll tick, so it is the *most* frequent writer, and an orphaned
 * server whose Claude Code pid had been recycled would otherwise keep stamping
 * keep-alive state into the newcomer's dir — holding a session open, on behalf
 * of monitors it never started. Same invariant `spoolReport` enforces (see
 * `ownsSpool`); here it goes quiet rather than throwing, because there is no
 * caller to report to.
 */
export function writeSessionState(claudePid: number, state: SessionState): void {
  const dir = spoolDirFor(claudePid)
  const path = join(dir, SESSION_STATE_FILE)
  if (!ownsSpool(claudePid)) return
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state), "utf8")
    renameSync(tmp, path)
  } catch {
    // Best-effort: a session that cannot record keep-alive state degrades to
    // the passive delivery model, which is the pre-keep-alive behaviour.
  }
}
