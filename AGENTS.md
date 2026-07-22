# AGENTS.md

Quick orientation for agents working on this repo. Read this before exploring; it captures the architecture and key facts.

## What this is

`pr-monitor` is a GitHub PR watcher that posts factual status updates back into the owning agent session. It is **dual-target**: an **opencode plugin** (`src/index.ts`) and a **Claude Code plugin** (`.claude-plugin/` + `claude/` + `hooks/`), both built on the same core.

## Project layout

```
src/                 # shared core + opencode shell
  index.ts     # opencode plugin entry. Sole export PrMonitorPlugin (loader invokes EVERY export — keep it the only one).
  config.ts    # pr-monitor.json loading; defaults + permissive validation. Takes explicit candidate paths.
  target.ts    # Parses PR target: "owner/repo#n" or full GitHub URL.
  github.ts    # GraphQL polling via `gh`; normalizes payload into PrSnapshot.
  activity.ts  # detectActivity(prev, next): what counts as a change.
  watch.ts     # PrWatch — per-PR state machine (tick, debounce, deliver).
  report.ts    # Markdown report rendering.
  label.ts     # mark_ready / unmark_ready: add or remove the readyLabel on a PR via gh REST.
claude/              # Claude Code shell (bundled; never executed from source)
  mcp-server.ts# MCP stdio server entry: pr_monitor tool, watches map, spool delivery, handoff set, shutdown notices.
  gh.ts        # gh runner via child_process (opencode uses Bun $).
  spool.ts     # spool write/GC: ~/.claude/pr-monitor/spool/<claude pid>/<ts>-<seq>.md (tmp+rename).
  session-state.ts # keep-alive state published to the hooks: <spool dir>/session.json.
hooks/
  hooks.json       # wires drain-spool.mjs to UserPromptSubmit / PostToolUse / Stop.
  drain-spool.mjs  # dependency-free: drains this session's spool, injects reports (additionalContext / Stop block), runs the keep-alive loop.
  await-activity.mjs # dependency-free blocking waiter; NOT a hook — the Stop block tells the session to run it via Bash.
skills/
  monitor-pr/      # the behavior: start on PR creation, act on every report, hand off when clean, take back on human feedback.
commands/            # /pr-monitor:watch, /pr-monitor:status, /pr-monitor:ready, /pr-monitor:unready
.mcp.json            # declares the MCP server (node ${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.mjs) — plugin-root convention.
.claude-plugin/
  plugin.json      # plugin metadata only (name/version/description/...); components are discovered by convention
                   # (.mcp.json, hooks/hooks.json, commands/) — an inline mcpServers field here is NOT picked up (tested on 2.1.216).
  marketplace.json # marketplace so the repo can be added with /plugin marketplace add.
dist/
  mcp-server.mjs   # committed esbuild bundle (plugin installs run NO build step — rebuild + commit on change).
```

## Core flow (both shells)

1. **start** — parse target → dedupe → `loadConfig` → fetch initial snapshot → reject if not `OPEN` → `new PrWatch(...)` → arm `setInterval(tick, pollIntervalSeconds*1000)`.
2. **tick** — `PrWatch.tick()` (`src/watch.ts`): fetch snapshot → `detectActivity` → mark dirty/reset debounce → `maybeAutoFlush()`.
3. **deliver** — shell-specific, injected as `deps.deliver`:
   - opencode (`src/index.ts`): `client.session.promptAsync(...)` pushes a `[PR Monitor]` message into the owning session. `promptAsync` never rejects on server error — check `result.error`. `agent` captured at start time (default agent may be a subagent, which fails); model captured per-message via the `chat.message` hook.
   - Claude Code (`claude/mcp-server.ts`): `spoolReport()` writes one file per report under `~/.claude/pr-monitor/spool/<claude pid>/`; the plugin's hooks inject spooled text at the next UserPromptSubmit / PostToolUse / Stop event (Stop blocks turn-end so pending reports are addressed). Claude Code has no push channel into a session, so delivery itself is passive by necessity; the keep-alive loop (below) is what stops that mattering while a PR is still in flight.

## Key behaviors / gotchas

- **Debounce + CI-hold** in `maybeAutoFlush` (`src/watch.ts`): wait `debounceMinutes` of quiet after activity; if CI is running on an OPEN PR, hold up to `maxCiWaitMinutes` before flushing.
- **detectActivity** (`src/activity.ts`): state, mergeable, reviews, unresolved threads, inline comments, issue comments, and CI **conclusion** count as activity. CI transitions into "running" and per-check progress do **NOT**. Mergeability is compared against the last *definite* (MERGEABLE/CONFLICTING) value — tracked by `PrWatch.lastDefiniteMergeable` — so transient `UNKNOWN` churn from base-branch merges stays quiet while a real `MERGEABLE -> UNKNOWN -> CONFLICTING` settle is still caught.
- **Failure handling** — notFound → stop with notice; 10 consecutive poll failures → stop; 10 consecutive delivery failures → stop. Delivery failures roll back the baseline so the same activity is retried.
- **Reentrancy guard** — `runExclusive` (per-watch promise queue) serializes `tick()` and `manualFlush()` so overlapping fetches can't apply out of order; ticks skip while an op is pending, manual flushes queue. `tick` also re-checks `stopped` after its awaited fetch so a concurrent `stop()` prevents any late apply/deliver.
- **Sessions, Claude Code shell**: one MCP server process per Claude Code process, so the watches map IS the session scope. Monitors survive `/clear` (same process) and die with the process. Spool routing: spool dirs are named by the owning Claude Code pid (= MCP server's ppid); the hook drains dirs named by its parent/grandparent pid (hook ← sh ← claude; deliberately NOT the full ancestry, which would let a nested claude session steal the outer session's reports), GCs dead-pid dirs, and falls back to all-live-dirs where `ps` is unavailable. Drains claim each report via unlink-before-emit so concurrent hook invocations never deliver one twice, and the script must not process.exit after writing (stdout past the 64KB pipe buffer would be truncated). PostToolUse also fires for tool calls inside Task subagents — those hook inputs carry `agent_id`, and drain-spool.mjs skips them so a report is never consumed by a subagent's context (verified empirically on Claude Code 2.1.216). Shutdown (stdin EOF/SIGTERM) spools a `Monitor stopped` notice per watch — delivered if the same process continues (server restart), silently GC'd if the session is gone.
- **Reload takeover, opencode shell** — `globalThis.__sesoriPrMonitorTakeovers` kills zombie timers from prior plugin instances; old watches send one factual stop notice. (`session.deleted` stops matching watches silently; graceful `dispose` delivers shutdown notices.)
- Reports are **facts only**: counts and authors, never comment bodies or advice.
- **mark_ready / unmark_ready** (both shells, `src/label.ts`) — add/remove `config.readyLabel` (default `ready-for-human-review`) via the gh REST API. Both verify the target via `pulls/{n}` first and refuse non-open targets (`assertOpenPullRequest`) — the labels endpoints operate on the shared issue namespace, so a plain issue number or merged/closed PR would otherwise be labeled with a false success. `mark_ready` pre-creates the label (green, described) because the add endpoint auto-creates missing labels as grey/undescribed; that create call's failure (usually 422 already_exists) is swallowed, the add call fails loudly. `unmark_ready` treats a 404 from the delete as success (the PR simply did not carry the label). Standalone: neither needs an active monitor.
- **Keep-alive loop, Claude Code shell** — the answer to "Claude Code has no push channel": while a monitored PR is not handed off, the Stop hook refuses turn-end and hands the session a Bash command running `hooks/await-activity.mjs`, which blocks until a report is spooled. One model round trip per real event, not per poll. Wiring: `claude/session-state.ts` publishes `{keepAlive, expiresAtMs, keepAliveUntilMs, monitors}` to `<spool dir>/session.json`; the MCP server rewrites it on every watch-set/handoff change **and after every poll tick** (the tick rewrite is the liveness heartbeat — `expiresAtMs` lapsing is how the hooks learn the server died). `keepAliveUntilMs` is the rolling *idle* cap (`keepAliveMaxMinutes`), refreshed by every delivery, so work is unbounded but silence is not. `mark_ready` adds the target to the in-memory `handedOff` set (monitoring continues, but it no longer holds the session); any later delivery for that target removes it again — new activity on a handed-off PR is exactly the human feedback the loop exists to catch. The waiter never unlinks reports: it only detects that one exists, and the PostToolUse drain that fires when it exits does the exactly-once delivery. `drain-spool.mjs` additionally rate-limits consecutive report-less keep-alive blocks (30s, marker file `.keepalive`) so a broken waiter degrades to turn-end instead of a tight spin. Labels are reported (`- Labels:` in `buildReport`) but deliberately excluded from `detectActivity` — the agent applies the label itself, and counting it as activity would make every `mark_ready` deliver a report that immediately re-opens the loop.

## Configuration

`pr-monitor.json`, loaded fresh per start: opencode looks in `<directory>/.opencode/`, then `<worktree>/.opencode/`; Claude Code looks in `<project>/.claude/`, then `<project>/.opencode/`. See `src/config.ts` for keys/defaults (`debounceMinutes` 5, `maxCiWaitMinutes` 30, `pollIntervalSeconds` 60 min 30, `ignoreCommentTag`, `announceOnStart` true, `readyLabel` `ready-for-human-review`, and — Claude Code only — `desktopNotifications` false, `keepAlive` true, `keepAliveMaxMinutes` 120). `resolveConfig` is permissive: unknown keys ignored, invalid values dropped, invalid JSON logged (not thrown), missing file → defaults.

## GitHub layer

- Injected `GhRunner`: opencode wraps Bun `$` (`createGhRunner`, `src/github.ts`); Claude Code wraps `child_process.execFile` (`claude/gh.ts`). Both throw `PollError(msg, { notFound })` on failure.
- Single GraphQL doc `PR_QUERY` (`src/github.ts`) fetches title, url, state, mergeable, head SHA, latest commit's check rollup, review requests/latestReviews, review threads + comments, issue comment count, labels.
- `normalizeSnapshot` → `PrSnapshot`; `ciPhase` → `none|running|concluded`.

## Building / releasing

- `npm run typecheck` covers `src/` and `claude/`. `npm run build` bundles `claude/mcp-server.ts` → `dist/mcp-server.mjs` (esbuild, ESM, node18 target, createRequire banner for CJS deps). **`dist/` is committed** — Claude Code plugin installs copy files and run no build, so rebuild + commit whenever `claude/` or `src/` changes.
- `hooks/drain-spool.mjs` and `hooks/await-activity.mjs` must stay dependency-free (node builtins only) and keep their path/format schemes in sync with `claude/spool.ts` and `claude/session-state.ts`. They are shipped as source, not bundled — only `claude/` goes through esbuild.
- `skills/monitor-pr/SKILL.md` ships with the Claude Code plugin (discovered by convention, like `commands/`). It is the *behavior* layer: changing what the loop does usually means editing it, not the TypeScript. opencode does not load plugin-shipped skills — the equivalent there lives in the consuming repo's `.opencode/skills/`.
- A release is an annotated `vX.Y.Z` Git tag pushed to GitHub; no npm publication. Before tagging: update `package.json`, `package-lock.json`, `.claude-plugin/plugin.json` version, `CHANGELOG.md`, run `npm run build`, commit, then `git tag -a vX.Y.Z -m "vX.Y.Z — summary"` and push commit + tag.
