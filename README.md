# pr-monitor

A GitHub PR monitor for coding agents, available as both an [opencode](https://opencode.ai) plugin and a [Claude Code](https://code.claude.com) plugin. It watches pull requests in the background and delivers factual `[PR Monitor]` reports into the session that started the watch — so an agent (or you) can raise a PR, keep working, and get told when something actually happened.

## What it does

- Polls GitHub via `gh api graphql` (one query per watched PR per tick, with extra pages only for PRs exceeding 100 review threads).
- Detects: CI suite conclusions, new reviews, new inline/issue comments (including follow-ups on existing or resolved review threads), review-thread resolution changes, mergeability changes, merge/close.
- Aggregates ordinary activity with a **rolling debounce**: any new activity resets a quiet timer; a report is delivered after the PR has been quiet for the configured window.
- **Instant CI failures**: a check going red skips the debounce and the CI hold — the report goes out at the next poll, carrying whatever else was buffered, so the agent starts fixing CI instead of waiting out a timer that PR comments keep resetting.
- **Instant conflicts and terminal states**: a newly detected merge conflict, merge, or close also reports at the next poll without waiting for the debounce or CI hold.
- **CI hold**: a due report is held while a check suite is still running (bounded by `maxCiWaitMinutes`), so you get one report with the CI verdict instead of two.
- Reports are **facts only** — counts, authors, check names. No advice, no comment bodies.
- Monitors are **per-session and in-memory**: they stop automatically when the PR is merged/closed, and they do not survive a host restart.

### Example report

```
[PR Monitor] [sesori-ai/example#42](https://github.com/sesori-ai/example/pull/42) — "feat: add relay reconnect backoff"
- CI: failing (1/8 failed: analyze)
- Mergeable: MERGEABLE
- Reviews: alice ✓ approved · bob ⏳ pending
- [comment:inline] 3 unresolved threads; 2 threads received 2 new comments since last flush (1 currently unresolved, 1 currently resolved; 2 coderabbitai[bot])
- [comment:issue] 5 total (1 new since last flush: 1 alice)
```

## Requirements

- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth status`).
- For Claude Code: Node.js >= 18 on `PATH` (runs the bundled MCP server), macOS or Linux.
- For opencode: opencode >= 1.17.

## Claude Code

### Install

```
/plugin marketplace add sesori-ai/opencode-pr-monitor
/plugin install pr-monitor@sesori
```

For local development, add the marketplace from a checkout instead: `/plugin marketplace add /path/to/opencode-pr-monitor`.

### Usage

The plugin registers a `pr_monitor` MCP tool with the same actions as the opencode version (see the table below), a `monitor-pr` skill that tells Claude how to use it, and four convenience commands:

- `/pr-monitor:watch [owner/repo#123 | PR URL]` — start monitoring (with no argument, Claude resolves the current branch's PR via `gh pr view`).
- `/pr-monitor:status` — list this session's active monitors.
- `/pr-monitor:ready [owner/repo#123 | PR URL]` — mark the PR as ready for human review (adds the `readyLabel` label on GitHub).
- `/pr-monitor:unready [owner/repo#123 | PR URL]` — withdraw that label again.

### Unattended mode: PR raised → comments addressed → flagged for review

The bundled `monitor-pr` skill turns reports into work, so the normal path needs no prompting from you:

1. Claude opens a PR and starts a monitor for it straight away.
2. Every report is acted on — review comments via the repo's `address-pr-comments` skill, failing CI by fixing the cause, conflicts by merging the base branch in.
3. When CI is green, no review threads are unresolved, no requested reviewer is still pending and nothing is left unanswered, Claude calls `mark_ready` — the PR gets the configured `readyLabel` (default `ready-for-human-review`) and it is your turn.
4. If a human then comments, the next report takes the PR back: Claude withdraws the label, works the feedback, and hands off again.

### How reports arrive (and how that differs from opencode)

Claude Code has no way for a background process to push a message into a session, so delivery is passive. The bundled MCP server spools finished reports, and plugin hooks inject them into the conversation at the next opportunity:

- immediately after any tool call Claude makes (`PostToolUse`),
- when you submit a prompt (`UserPromptSubmit`),
- when Claude tries to end its turn (`Stop`) — a pending report holds the turn open so Claude addresses it before going idle.

That alone still leaves a gap: a report landing while the session sits idle waits until your next message. **Keep-alive** closes it. While a monitored PR has not been handed off with `mark_ready`, the `Stop` hook refuses turn-end and points Claude at `claude-code/hooks/await-activity.mjs`, a small script that blocks until the next report is spooled. Claude waits inside a single tool call instead of going idle, and wakes the moment something happens — one model round trip per real event rather than one per polling tick.

Bounds, so a loop can never run away:

- It ends at the handoff (`mark_ready`), on `stop`, when the PR merges or closes, and when the MCP server goes away.
- `keepAliveMaxMinutes` (default 120) caps *idle* waiting; every delivered report refreshes it, so an active PR keeps going and an abandoned one lets go.
- <kbd>Esc</kbd> interrupts the wait like any other tool call, and asking Claude to stop wins over the loop.
- Set `"keepAlive": false` to switch the whole thing off and keep the passive-delivery behavior.

Prefer being told out of band instead? Set `desktopNotifications: true` for an OS notification when a report is waiting.

Further behavior notes for the Claude Code shell:

- Monitors belong to the Claude Code process. They survive `/clear` (the new conversation keeps receiving reports) and die with the process; they do not survive quitting Claude Code or `claude --resume` into a new process. If the MCP server is restarted while Claude Code keeps running (e.g. `/reload-plugins`), each active monitor delivers a `Monitor stopped` notice; when Claude Code itself exits, monitors simply die with it (no notice — there is no session left to deliver to).
- Config lives in `.claude/pr-monitor.json` (falling back to `.opencode/pr-monitor.json`, so a repo configured for the opencode plugin works as-is).

## opencode

### Install

Add the plugin to your project's `opencode.json` (committed — the whole team gets it) or to your global `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

opencode installs npm plugins and their dependencies into its package cache on startup. To make upgrades explicit, pin a version such as `@sesori/pr-monitor-opencode@0.2.1` and bump it deliberately. Quit and restart opencode after changing the plugin configuration.

Reports arrive in the owning session as messages starting with `[PR Monitor]`. Monitors stop when the owning session is deleted. On graceful opencode shutdown, a no-reply stop notice is persisted to each owning session before the plugin is disposed, so it is present in history when opencode starts again.

## The `pr_monitor` tool

Both shells register the same tool:

| Action   | `pr` argument                          | Effect |
| -------- | -------------------------------------- | ------ |
| `start`  | `owner/repo#123` or full PR URL        | Begin watching. The repo must be explicit — no cwd inference. |
| `stop`   | PR identifier or `all`                 | Stop watching. |
| `flush`  | PR identifier or `all`                 | On demand: immediately return a full status report and reset the "new since" baseline. Delivered reports already advance the baseline, so a flush after handling one isn't needed. |
| `status` | —                                      | List this session's active monitors. |
| `mark_ready` | `owner/repo#123` or full PR URL    | Add the configured `readyLabel` label to the PR on GitHub, signalling it is ready for human review. Creates the label in the repo (green, with a description) if it doesn't exist. In Claude Code this is also the **handoff** that releases the keep-alive loop. Works without an active monitor; refuses targets that are not open PRs (plain issues, merged/closed PRs). |
| `unmark_ready` | `owner/repo#123` or full PR URL  | Remove that label again — used when new feedback lands on a PR that was already flagged ready. Idempotent: a PR without the label reports so rather than failing. |

## Configuration

Optional, per project: `.claude/pr-monitor.json` for Claude Code (with `.opencode/pr-monitor.json` as fallback), `.opencode/pr-monitor.json` for opencode.

```json
{
  "debounceMinutes": 2,
  "maxCiWaitMinutes": 30,
  "pollIntervalSeconds": 60,
  "ignoreCommentTag": "<!-- pr-monitor:ignore -->",
  "announceOnStart": true,
  "flushOnCiFailure": true,
  "desktopNotifications": false,
  "readyLabel": "ready-for-human-review",
  "keepAlive": true,
  "keepAliveMaxMinutes": 120
}
```

| Key                    | Default | Meaning |
| ---------------------- | ------- | ------- |
| `debounceMinutes`      | `2`     | Quiet window after the last detected ordinary activity before a report is delivered. Rolling — new activity resets it. |
| `maxCiWaitMinutes`     | `30`    | Upper bound on holding a due report while CI is still running. After this, the report is force-flushed naming unfinished checks. |
| `pollIntervalSeconds`  | `60`    | GitHub poll interval per watched PR (clamped to 30 seconds … 24 hours). |
| `ignoreCommentTag`     | unset   | If set, comments authored by the authenticated `gh` user that contain this tag are invisible to the monitor — useful so an agent replying to review threads doesn't trigger its own reports. |
| `announceOnStart`      | `true`  | Deliver a full status report immediately when a monitor starts, so the session sees its starting point and can address anything already outstanding on the PR. Set `false` to disable. |
| `flushOnCiFailure`     | `true`  | Report a newly failing check at the next poll instead of waiting out `debounceMinutes` (and any CI hold), so CI fixes start sooner. Counts failures found while the suite is still running. At most one instant report per head commit — later failures on the same commit ride along with the debounced suite-conclusion report. Set `false` for debounce-only delivery. |
| `desktopNotifications` | `false` | Claude Code only: emit an OS notification (macOS/Linux) when a report is spooled, so an idle session's reports aren't silently waiting. |
| `readyLabel`           | `ready-for-human-review` | Label the `mark_ready` action applies to the PR on GitHub. |
| `keepAlive`            | `true`  | Claude Code only: while a monitored PR has not been handed off with `mark_ready`, refuse turn-end and have Claude wait for the next report instead of going idle. Set `false` for purely passive delivery. |
| `keepAliveMaxMinutes`  | `120`   | Claude Code only: cap on how long the keep-alive loop waits with *nothing happening*. Refreshed by every delivered report, so it bounds idle time rather than total work time. |

## Behavior details

- **Activity** = state/mergeability changes, review changes, per-thread resolution or visible-comment changes, issue comments, and CI *suite conclusions*. Transitions into "running" (a new push) and non-failing per-check progress are intentionally not activity.
- **CI failures bypass the timers** (`flushOnCiFailure`, default on). A check whose outcome is newly `failure` — including one found while the suite is still running, which is otherwise not activity — flushes on the spot: no quiet window, no CI hold. The report reads the suite honestly (`- CI: running (3/8 done, 1 failed so far: lint)`). The instant path fires at most once per head commit, so a matrix going red job by job cannot wake the session once per job; the suite's eventual conclusion still delivers the full verdict through the normal debounce, and the next push re-arms the instant path.
- **Conflicts and terminal states bypass the timers.** A newly observed `CONFLICTING` state (including an `UNKNOWN -> CONFLICTING` settle), merge, or close reports at the next poll and is never held behind running CI.
- **Review-thread follow-ups stay visible.** Inline comments retain their thread identity and current resolved/unresolved state. Reports state how many threads received visible comments since the last flush and split those threads by current state, so a follow-up on a previously handled or resolved thread cannot be mistaken for an unchanged unresolved-thread count. Comments filtered by `ignoreCommentTag` remain invisible.
- **"New since last flush"** compares stable GitHub comment IDs with the last delivered report or manual `flush`, so comments created within the same timestamp second are not lost.
- **Failure handling**: 10 consecutive poll failures (or report-delivery failures) stop the monitor with a notice. A failed initial status report retains its zero comment baseline and retries at the next poll. A deleted/inaccessible PR stops immediately.
- **Terminal states**: an immediate report describing a merged/closed PR is delivered with a `Monitor stopped: PR merged|closed` line, then the monitor stops itself. All stop reasons use the same `Monitor stopped: <reason>` phrasing.

## Development

```sh
npm install
npm test            # shared-core and OpenCode-shell regression tests
npm run typecheck   # core + both shells
npm run build       # bundle the Claude Code MCP server to claude-code/dist/mcp-server.mjs
npm run pack:check  # inspect the OpenCode npm package without creating a tarball
```

Layout — one directory per target, plus the shared core:

```
core/            shell-agnostic core: config, polling, activity detection, PrWatch, report rendering
opencode/        opencode shell — index.ts is the plugin entry
claude-code/     Claude Code shell — this directory is the plugin root (${CLAUDE_PLUGIN_ROOT})
.claude-plugin/  marketplace.json, which stays at the repo root and points at ./claude-code
```

`core/` never imports from a shell, so a shell is only wiring: transport, delivery, and config paths. opencode executes TypeScript directly (no build step), and the loader invokes every export of the entry module as a plugin, so `PrMonitorPlugin` must remain the sole export of `opencode/index.ts`. The `@sesori/pr-monitor-opencode` npm artifact is allowlisted to `core/` and `opencode/`; it does not contain the Claude Code distribution. The Claude Code shell is bundled with esbuild into the committed `claude-code/dist/mcp-server.mjs`, since plugin installs run no build step; `claude-code/hooks/drain-spool.mjs` is the dependency-free hook that injects spooled reports and runs the keep-alive loop, and `claude-code/hooks/await-activity.mjs` is the blocking waiter it hands to the session; `claude-code/skills/monitor-pr/` is the behavior — when to start a monitor, what to do with each report, when to hand off; `claude-code/.mcp.json` declares the MCP server (plugin-root convention — an inline `mcpServers` field in plugin.json is not picked up).

## Releasing

A release uses one version for both targets: the annotated `vX.Y.Z` Git tag releases the Claude Code plugin, and the root package publishes the OpenCode target as `@sesori/pr-monitor-opencode`. There is no separate GitHub Release step. Update `package.json`, `package-lock.json`, `claude-code/.claude-plugin/plugin.json`, and `CHANGELOG.md`, then run:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run pack:check
git diff --exit-code -- claude-code/dist/mcp-server.mjs
```

Commit any rebuilt bundle and the release metadata. From the clean release commit on `main`, publish before creating and pushing the tag; if npm rejects the package, there is no stale tag to announce a partial release:

```sh
git push origin main
npm publish
git tag -a vX.Y.Z -m "vX.Y.Z — summary"
git push origin vX.Y.Z
```

The first publication requires an npm account with permission to create public packages in the `@sesori` scope (`npm login`). `publishConfig` already fixes the registry to npmjs.org and the access level to public. npm versions are immutable, so verify the package name, version, and `npm run pack:check` output before publishing.

## License

[MIT](LICENSE)
