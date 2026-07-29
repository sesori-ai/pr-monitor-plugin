# AGENTS.md

Quick orientation for agents working on this repo. Read this before exploring; it captures the architecture and key facts.

## What this is

`pr-monitor` is a GitHub PR watcher that posts factual status updates back into the owning agent session. It is **dual-target**: an **opencode plugin** (`opencode/`) and a **Claude Code plugin** (`claude-code/`), both built on the same core (`core/`).

## Project layout

One directory per target, plus the shared core. The split is by dependency
direction: **`core/` imports nothing from a shell**, so a shell is only wiring
(transport, delivery, config paths). Add a target as a sibling directory.

```
core/                # Shared core — shell-agnostic.
  config.ts    # pr-monitor.json loading; defaults + permissive validation. Takes explicit candidate paths.
  target.ts    # Parses PR target: "owner/repo#n" or full GitHub URL.
  github.ts    # GraphQL polling via `gh`; normalizes payload into PrSnapshot.
  activity.ts  # detectActivity(prev, next): what counts as a change.
  watch.ts     # PrWatch — per-PR state machine (tick, debounce, deliver).
  report.ts    # Markdown report rendering.

opencode/            # opencode shell. Executed from source — opencode runs TypeScript directly.
  index.ts     # Plugin entry. Sole export PrMonitorPlugin (loader invokes EVERY export — keep it the only one).

claude-code/         # Claude Code shell. THIS DIRECTORY IS THE PLUGIN ROOT (= ${CLAUDE_PLUGIN_ROOT}).
  src/               # Bundled; never executed from source.
    mcp-server.ts# MCP stdio server entry: pr_monitor tool, watches map, spool delivery, shutdown notices.
    gh.ts        # gh runner via child_process (opencode uses Bun $).
    spool.ts     # spool write/GC: ~/.claude/pr-monitor/spool/<claude pid>/<ts>-<seq>.md (tmp+rename).
  hooks/
    hooks.json       # wires drain-spool.mjs to UserPromptSubmit / PostToolUse / Stop.
    drain-spool.mjs  # dependency-free: drains this session's spool, injects reports (additionalContext / Stop block).
  commands/          # /pr-monitor:watch, /pr-monitor:status
  .mcp.json          # declares the MCP server (node ${CLAUDE_PLUGIN_ROOT}/dist/mcp-server.mjs) — plugin-root convention.
  .claude-plugin/
    plugin.json      # plugin metadata only (name/version/description/...); components are discovered by convention
                     # (.mcp.json, hooks/hooks.json, commands/) — an inline mcpServers field here is NOT picked up (tested on 2.1.216).
  dist/
    mcp-server.mjs   # committed esbuild bundle (plugin installs run NO build step — rebuild + commit on change).

.claude-plugin/
  marketplace.json # MUST stay at the repo root — `/plugin marketplace add <repo>` reads it from there.
                   # Its plugin entry points at the plugin root with "source": "./claude-code";
                   # relative sources resolve against the directory containing .claude-plugin/.
```

Everything under `claude-code/` is addressed plugin-root-relative at runtime, so
`.mcp.json` and `hooks.json` (which use `${CLAUDE_PLUGIN_ROOT}`) are unaffected by
where the plugin root sits in the repo.

## Core flow (both shells)

1. **start** — parse target → dedupe → `loadConfig` → fetch initial snapshot → reject if not `OPEN` → `new PrWatch(...)` → arm `setInterval(tick, pollIntervalSeconds*1000)`.
2. **tick** — `PrWatch.tick()` (`core/watch.ts`): fetch snapshot → `detectActivity` → mark dirty/reset debounce → `maybeAutoFlush()`.
3. **deliver** — shell-specific, injected as `deps.deliver`:
   - opencode (`opencode/index.ts`): `client.session.promptAsync(...)` pushes a `[PR Monitor]` message into the owning session. `promptAsync` never rejects on server error — check `result.error`. `agent` captured at start time (default agent may be a subagent, which fails); model captured per-message via the `chat.message` hook.
   - Claude Code (`claude-code/src/mcp-server.ts`): `spoolReport()` writes one file per report under `~/.claude/pr-monitor/spool/<claude pid>/`; the plugin's hooks inject spooled text at the next UserPromptSubmit / PostToolUse / Stop event (Stop blocks turn-end so pending reports are addressed). Claude Code has no push channel into a session — delivery is passive by necessity.

## Key behaviors / gotchas

- **Debounce + CI-hold** in `maybeAutoFlush` (`core/watch.ts`): wait `debounceMinutes` of quiet after activity; if CI is running on an OPEN PR, hold up to `maxCiWaitMinutes` before flushing.
- **detectActivity** (`core/activity.ts`): state, mergeable, reviews, unresolved threads, inline comments, issue comments, and CI **conclusion** count as activity. CI transitions into "running" and per-check progress do **NOT**. Mergeability is compared against the last *definite* (MERGEABLE/CONFLICTING) value — tracked by `PrWatch.lastDefiniteMergeable` — so transient `UNKNOWN` churn from base-branch merges stays quiet while a real `MERGEABLE -> UNKNOWN -> CONFLICTING` settle is still caught.
- **Failure handling** — notFound → stop with notice; 10 consecutive poll failures → stop; 10 consecutive delivery failures → stop. Delivery failures roll back the baseline so the same activity is retried.
- **Reentrancy guard** — `runExclusive` (per-watch promise queue) serializes `tick()` and `manualFlush()` so overlapping fetches can't apply out of order; ticks skip while an op is pending, manual flushes queue. `tick` also re-checks `stopped` after its awaited fetch so a concurrent `stop()` prevents any late apply/deliver.
- **Sessions, Claude Code shell**: one MCP server process per Claude Code process, so the watches map IS the session scope. Monitors survive `/clear` (same process) and die with the process. Spool routing: spool dirs are named by the owning Claude Code pid (= MCP server's ppid); the hook drains dirs named by its parent/grandparent pid (hook ← sh ← claude; deliberately NOT the full ancestry, which would let a nested claude session steal the outer session's reports), GCs dead-pid dirs, and falls back to all-live-dirs where `ps` is unavailable. Drains claim each report via unlink-before-emit so concurrent hook invocations never deliver one twice, and the script must not process.exit after writing (stdout past the 64KB pipe buffer would be truncated). PostToolUse also fires for tool calls inside Task subagents — those hook inputs carry `agent_id`, and drain-spool.mjs skips them so a report is never consumed by a subagent's context (verified empirically on Claude Code 2.1.216). Shutdown (stdin EOF/SIGTERM) spools a `Monitor stopped` notice per watch — delivered if the same process continues (server restart), silently GC'd if the session is gone.
- **Reload takeover, opencode shell** — `globalThis.__sesoriPrMonitorTakeovers` kills zombie timers from prior plugin instances; old watches send one factual stop notice. (`session.deleted` stops matching watches silently; graceful `dispose` delivers shutdown notices.)
- Reports are **facts only**: counts and authors, never comment bodies or advice.

## Configuration

`pr-monitor.json`, loaded fresh per start: opencode looks in `<directory>/.opencode/`, then `<worktree>/.opencode/`; Claude Code looks in `<project>/.claude/`, then `<project>/.opencode/`. See `core/config.ts` for keys/defaults (`debounceMinutes` 5, `maxCiWaitMinutes` 30, `pollIntervalSeconds` 60 min 30, `ignoreCommentTag`, `announceOnStart` true, `desktopNotifications` false — Claude Code only). `resolveConfig` is permissive: unknown keys ignored, invalid values dropped, invalid JSON logged (not thrown), missing file → defaults.

## GitHub layer

- Injected `GhRunner`: opencode wraps Bun `$` (`createGhRunner`, `core/github.ts`); Claude Code wraps `child_process.execFile` (`claude-code/src/gh.ts`). Both throw `PollError(msg, { notFound })` on failure.
- Single GraphQL doc `PR_QUERY` (`core/github.ts`) fetches title, url, state, mergeable, head SHA, latest commit's check rollup, review requests/latestReviews, review threads + comments, issue comment count.
- `normalizeSnapshot` → `PrSnapshot`; `ciPhase` → `none|running|concluded`.

## Building / releasing

- `npm run typecheck` covers `core/`, `opencode/` and `claude-code/src/`. `npm run build` bundles `claude-code/src/mcp-server.ts` → `claude-code/dist/mcp-server.mjs` (esbuild, ESM, node18 target, createRequire banner for CJS deps). **`claude-code/dist/` is committed** — Claude Code plugin installs copy files and run no build, so rebuild + commit whenever `claude-code/src/` or `core/` changes. The bundle is marked `linguist-generated` in `.gitattributes` so it collapses in GitHub diffs; review the sources, not the bundle.
- `claude-code/hooks/drain-spool.mjs` must stay dependency-free (node builtins only) and keep its spool path scheme in sync with `claude-code/src/spool.ts`.
- A release is an annotated `vX.Y.Z` Git tag pushed to GitHub; no npm publication. Before tagging: update `package.json`, `package-lock.json`, `claude-code/.claude-plugin/plugin.json` version, `CHANGELOG.md`, run `npm run build`, commit, then `git tag -a vX.Y.Z -m "vX.Y.Z — summary"` and push commit + tag.
