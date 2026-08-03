# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1]

### Added

- The OpenCode plugin is now prepared for npm distribution as the public scoped package `@sesori/pr-monitor-opencode`. Its package entry points support both standard package imports and OpenCode's `./server` lookup, and the published artifact is restricted to the OpenCode shell plus the shared core.
- **Instant CI-failure reports** (config `flushOnCiFailure`, default `true`). A failing check no longer waits out `debounceMinutes` — a window that unrelated PR comments kept resetting, so a red CI could sit unreported for a long time before the session started fixing it. Any check newly in `failure` now flushes on the spot, carrying whatever activity was buffered so far, skipping both the quiet window and the CI hold. Failures found while the suite is still running count too (previously not activity at all, so a lint failure in minute 1 of a 20-minute suite waited for the whole suite plus the debounce); the report states the suite honestly, e.g. `- CI: running (3/8 done, 1 failed so far: lint)`. Capped at one instant report per head commit so a matrix going red job by job cannot wake the session once per job — the suite's conclusion still delivers the full verdict through the normal debounce, and the next push re-arms the instant path.
- **Instant conflict and terminal-state reports.** A newly detected merge conflict, merge, or close now bypasses both the debounce and a running-CI hold and reports at the next poll.
- Inline-comment reports now preserve review-thread and comment identity plus current resolution state. They state how many resolved and unresolved threads received visible comments since the last flush, making a human follow-up on an already answered or resolved thread explicit even when the unresolved-thread total is unchanged. Polling paginates beyond GitHub's first 100 review threads, and ignored tagged replies cannot create false visible-comment activity when a full 100-comment thread window rolls over.

### Changed

- The default `debounceMinutes` quiet window is now 2 minutes (previously 5).

### Fixed

- Auto-flush report delivery is awaited inside the watch's exclusive op instead of being fire-and-forget. Its failure path restores exactly the state a later flush advances (`lastFlushAt`, `lastFlushedSnapshot`, `dirty`, `holdStartedAt`), so a delivery that rejected after a newer report had already flushed could rewind that newer report's "new since" baseline — and, with the instant CI path above, re-fire a duplicate report immediately. Ticks now skip while a report is in flight, which is the intended trade-off: there is nothing useful to do with a fresher snapshot while the previous report is stuck.
- "New since last flush" now compares comment IDs with the last flushed snapshot instead of relying only on second-granularity GitHub timestamps, which could render a newly detected follow-up as `0 new` when it landed in the same second as the prior flush.
- Failed initial status delivery no longer advances the comment or timestamp baseline. The complete startup report is retained as urgent and retried at the next poll, preventing comments present when monitoring began from being permanently hidden.
- OpenCode shutdown notices now use synchronous `session.prompt` with `noReply: true`. The previous `promptAsync` call returned before its background task persisted the message, and instance disposal then cancelled that task, so the advertised shutdown notice was usually lost.

## [0.2.0]

### Added

- **Claude Code plugin.** The repo is now dual-target: alongside the opencode plugin, it ships a Claude Code plugin (`claude-code/` — manifest, bundled MCP stdio server, hooks, `/pr-monitor:watch` and `/pr-monitor:status` commands) built on the same core (`core/`). Claude Code cannot push messages into a session, so delivery is passive: the MCP server (`claude-code/src/mcp-server.ts`, bundled to `claude-code/dist/mcp-server.mjs`) spools reports to `~/.claude/pr-monitor/spool/<claude pid>/`, and plugin hooks (`claude-code/hooks/drain-spool.mjs`) inject them into the conversation at the next user prompt, tool call, or turn end (the Stop hook holds an ending turn to deliver pending reports).
- `desktopNotifications` config option (default `false`, Claude Code shell only): emit an OS notification when a report is spooled, covering the gap where a report lands while the session is idle.
- The Claude Code shell reads config from `.claude/pr-monitor.json`, falling back to `.opencode/pr-monitor.json`.
- `mark_ready` tool action (both shells) and `/pr-monitor:ready` command: add the configured `readyLabel` label (default `ready-for-human-review`, created green with a description if missing from the repo) to a PR on GitHub, signalling it is ready for human review. Works without an active monitor; refuses targets that are not open PRs (plain issues, merged/closed PRs).
- `unmark_ready` tool action (both shells) and `/pr-monitor:unready` command: remove that label again, for when new feedback lands on a PR that was already flagged ready. Idempotent — a PR that does not carry the label reports so instead of failing.
- **`monitor-pr` skill**, shipped with the Claude Code plugin. The behavior layer that was previously missing on the Claude Code side: start a monitor immediately after raising a PR, act on every report (review comments via `address-pr-comments`, failing CI, conflicts), hand the PR off with `mark_ready` once CI is green with no unresolved threads and no pending reviewers, and take it back — withdrawing the label — when a human responds.
- **Keep-alive loop** (Claude Code shell, config `keepAlive` default `true`, `keepAliveMaxMinutes` default `120`). Passive delivery meant a report arriving while the session sat idle waited until the user next typed. Now, while a monitored PR has not been handed off, the `Stop` hook refuses turn-end and hands the session a command running the new `claude-code/hooks/await-activity.mjs`, which blocks until the next report is spooled — so the session wakes on real events rather than polling, at one model round trip per event. Bounded by the handoff, `stop`, PR merge/close, MCP server exit, and the rolling idle cap; interruptible with <kbd>Esc</kbd>. State is published to `<spool dir>/session.json` by the MCP server (`claude-code/src/session-state.ts`) and refreshed on every poll tick as a liveness heartbeat.
- Reports now include a `- Labels:` line when the PR carries labels, so a session can tell whether a PR is already handed off. Labels are deliberately not treated as activity — the agent applies the label itself.

### Changed

- Repository layout split by dependency direction: `src/` became `core/` (shell-agnostic polling, activity detection, `PrWatch`, report rendering), `opencode/` (the opencode shell) and `claude-code/` (the Claude Code shell, which is also the plugin root). Neither install spec changes: `package.json` `main` points at `opencode/index.ts`, and the root `.claude-plugin/marketplace.json` points its plugin entry at `./claude-code`.
- `loadConfig` now takes explicit candidate file paths instead of directories (shared-core change; opencode behavior unchanged).
- `PrWatch.announceInitial` returns a promise so the Claude Code shell can spool the initial report before the `start` tool call returns (opencode behavior unchanged).

### Fixed

- `PrWatch` operations are serialized through a per-watch promise queue: concurrent `manualFlush` calls could interleave their fetches and restore a stale snapshot/baseline. Ticks now skip while an operation is pending, and manual flushes queue.
- `stop()` during an in-flight poll no longer delivers the late report: `tick` re-checks the stopped flag after its awaited fetch, so nothing is applied or delivered once the tool has reported "Stopped".

## [0.1.6]

### Fixed

- Graceful opencode shutdowns now stop active timers, deliver a factual stop notice to each owning session, and await all delivery attempts before plugin disposal completes. Abrupt process termination remains undetectable.

## [0.1.5]

### Fixed

- Mergeability tracking now compares against the last *definite* state (MERGEABLE/CONFLICTING) instead of the immediately previous poll. A real `MERGEABLE -> UNKNOWN -> CONFLICTING` settle spans two polls; because `0.1.4` suppressed every UNKNOWN-side transition, once the previous snapshot became the transient UNKNOWN the genuine conflict was swallowed and never reported. Carrying the last definite value across UNKNOWN polls keeps base-branch churn quiet while still catching a conflict once it resolves.

## [0.1.4]

### Changed

- Transient `UNKNOWN` mergeability churn from base-branch merges (`MERGEABLE -> UNKNOWN -> MERGEABLE`) no longer counts as activity; only settled transitions between definite mergeability states are report-worthy.

## [0.1.3]

### Added

- `announceOnStart` config option (default `true`): on start, a monitor delivers a full status report immediately so the session sees its starting point and can address anything already outstanding on the PR (including comments added during a delayed startup, which periodic polling would otherwise treat as pre-existing and never report). Set `false` to disable.

## [0.1.2]

### Added

- Reports render the PR as a clickable Markdown link (`[owner/repo#n](url)`); all `[PR Monitor]` messages are Markdown.
- Merged/closed PR reports end with a `Monitor stopped: PR merged|closed` line, so a self-close is explicit.

### Changed

- Every stop reason now uses one consistent `Monitor stopped: <reason>` phrasing (terminal merge/close, PR not found, repeated poll failures, plugin reload).
- The `flush` action is documented as on-demand: a delivered report already advances the "new since" baseline, so a manual flush after handling a report is not needed.

## [0.1.1]

### Fixed

- Report deliveries reuse the session's last user-selected model (captured via the `chat.message` hook) instead of letting the server re-resolve the model at delivery time, which on a long-lived watch could drift onto a model that had since been removed.

## [0.1.0]

### Added

- Initial release: a background GitHub PR monitor that delivers factual `[PR Monitor]` reports into the owning opencode session.
