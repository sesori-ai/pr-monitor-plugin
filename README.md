# pr-monitor

A GitHub PR monitor for coding agents, available as both an [opencode](https://opencode.ai) plugin and a [Claude Code](https://code.claude.com) plugin. It watches pull requests in the background and delivers factual `[PR Monitor]` reports into the session that started the watch — so an agent (or you) can raise a PR, keep working, and get told when something actually happened.

## What it does

- Polls GitHub via `gh api graphql` (one query per watched PR per tick).
- Detects: CI suite conclusions, new reviews, new inline/issue comments, unresolved-thread count changes, mergeability changes, merge/close.
- Aggregates activity with a **rolling debounce**: any new activity resets a quiet timer; a report is delivered only after the PR has been quiet for the configured window.
- **CI hold**: a due report is held while a check suite is still running (bounded by `maxCiWaitMinutes`), so you get one report with the CI verdict instead of two.
- Reports are **facts only** — counts, authors, check names. No advice, no comment bodies.
- Monitors are **per-session and in-memory**: they stop automatically when the PR is merged/closed, and they do not survive a host restart.

### Example report

```
[PR Monitor] [sesori-ai/example#42](https://github.com/sesori-ai/example/pull/42) — "feat: add relay reconnect backoff"
- CI: failing (1/8 failed: analyze)
- Mergeable: MERGEABLE
- Reviews: alice ✓ approved · bob ⏳ pending
- [comment:inline] 3 unresolved threads (2 new since last flush: 2 coderabbitai[bot])
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

The plugin registers a `pr_monitor` MCP tool with the same actions as the opencode version (see the table below), plus two convenience commands:

- `/pr-monitor:watch [owner/repo#123 | PR URL]` — start monitoring (with no argument, Claude resolves the current branch's PR via `gh pr view`).
- `/pr-monitor:status` — list this session's active monitors.

### How reports arrive (and how that differs from opencode)

Claude Code has no way for a background process to push a message into a session, so delivery is passive. The bundled MCP server spools finished reports, and plugin hooks inject them into the conversation at the next opportunity:

- immediately after any tool call Claude makes (`PostToolUse`),
- when you submit a prompt (`UserPromptSubmit`),
- when Claude tries to end its turn (`Stop`) — a pending report holds the turn open so Claude addresses it before going idle.

In practice: while Claude is working, reports arrive mid-task, and a report that lands during a turn is handled before the turn ends. If the session is fully idle, a report waits until your next message — set `desktopNotifications: true` to get an OS notification when a report is waiting.

Further behavior notes for the Claude Code shell:

- Monitors belong to the Claude Code process. They survive `/clear` (the new conversation keeps receiving reports) and die with the process; they do not survive quitting Claude Code or `claude --resume` into a new process. If the MCP server is restarted while Claude Code keeps running (e.g. `/reload-plugins`), each active monitor delivers a `Monitor stopped` notice; when Claude Code itself exits, monitors simply die with it (no notice — there is no session left to deliver to).
- Config lives in `.claude/pr-monitor.json` (falling back to `.opencode/pr-monitor.json`, so a repo configured for the opencode plugin works as-is).

## opencode

### Install

Add the plugin to your project's `opencode.json` (committed — the whole team gets it) or to your global `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["github:sesori-ai/opencode-pr-monitor#v0.2.0"]
}
```

opencode installs git-spec plugins into its package cache on startup. Pin a tag and bump it explicitly to pick up new versions.

Reports arrive in the owning session as messages starting with `[PR Monitor]`. Monitors stop when the owning session is deleted; graceful opencode shutdowns deliver a stop notice to the owning session.

## The `pr_monitor` tool

Both shells register the same tool:

| Action   | `pr` argument                          | Effect |
| -------- | -------------------------------------- | ------ |
| `start`  | `owner/repo#123` or full PR URL        | Begin watching. The repo must be explicit — no cwd inference. |
| `stop`   | PR identifier or `all`                 | Stop watching. |
| `flush`  | PR identifier or `all`                 | On demand: immediately return a full status report and reset the "new since" baseline. Delivered reports already advance the baseline, so a flush after handling one isn't needed. |
| `status` | —                                      | List this session's active monitors. |

## Configuration

Optional, per project: `.claude/pr-monitor.json` for Claude Code (with `.opencode/pr-monitor.json` as fallback), `.opencode/pr-monitor.json` for opencode.

```json
{
  "debounceMinutes": 5,
  "maxCiWaitMinutes": 30,
  "pollIntervalSeconds": 60,
  "ignoreCommentTag": "<!-- pr-monitor:ignore -->",
  "announceOnStart": true,
  "desktopNotifications": false
}
```

| Key                    | Default | Meaning |
| ---------------------- | ------- | ------- |
| `debounceMinutes`      | `5`     | Quiet window after the last detected activity before a report is delivered. Rolling — new activity resets it. |
| `maxCiWaitMinutes`     | `30`    | Upper bound on holding a due report while CI is still running. After this, the report is force-flushed naming unfinished checks. |
| `pollIntervalSeconds`  | `60`    | GitHub poll interval per watched PR (clamped to 30 seconds … 24 hours). |
| `ignoreCommentTag`     | unset   | If set, comments authored by the authenticated `gh` user that contain this tag are invisible to the monitor — useful so an agent replying to review threads doesn't trigger its own reports. |
| `announceOnStart`      | `true`  | Deliver a full status report immediately when a monitor starts, so the session sees its starting point and can address anything already outstanding on the PR. Set `false` to disable. |
| `desktopNotifications` | `false` | Claude Code only: emit an OS notification (macOS/Linux) when a report is spooled, so an idle session's reports aren't silently waiting. |

## Behavior details

- **Activity** = state/mergeability changes, review changes, unresolved-thread count changes, new comments, and CI *suite conclusions*. Transitions into "running" (a new push) and per-check progress are intentionally not activity.
- **"New since last flush"** counts comments created after the watch's baseline, which advances on every delivered report or manual `flush`.
- **Failure handling**: 10 consecutive poll failures (or report-delivery failures) stop the monitor with a notice. A deleted/inaccessible PR stops it immediately.
- **Terminal states**: a report describing a merged/closed PR is delivered with a `Monitor stopped: PR merged|closed` line, then the monitor stops itself. All stop reasons use the same `Monitor stopped: <reason>` phrasing.

## Development

```sh
npm install
npm run typecheck   # core + both shells
npm run build       # bundle the Claude Code MCP server to claude-code/dist/mcp-server.mjs
```

Layout — one directory per target, plus the shared core:

```
core/            shell-agnostic core: config, polling, activity detection, PrWatch, report rendering
opencode/        opencode shell — index.ts is the plugin entry
claude-code/     Claude Code shell — this directory is the plugin root (${CLAUDE_PLUGIN_ROOT})
.claude-plugin/  marketplace.json, which stays at the repo root and points at ./claude-code
```

`core/` never imports from a shell, so a shell is only wiring: transport, delivery, and config paths. opencode executes TypeScript directly (no build step), and the loader invokes every export of the entry module as a plugin, so `PrMonitorPlugin` must remain the sole export of `opencode/index.ts`. The Claude Code shell is bundled with esbuild into the committed `claude-code/dist/mcp-server.mjs`, since plugin installs run no build step; `claude-code/hooks/drain-spool.mjs` is the dependency-free hook that injects spooled reports; `claude-code/.mcp.json` declares the MCP server (plugin-root convention — an inline `mcpServers` field in plugin.json is not picked up).

## Releasing

A release is created by pushing an annotated version tag (`vX.Y.Z`) to a commit on GitHub. There is no npm publication or separate GitHub Release step, but `claude-code/dist/` must be rebuilt and committed when the Claude Code shell or the shared core changes. Update `package.json`, `package-lock.json`, `claude-code/.claude-plugin/plugin.json`, and `CHANGELOG.md`, run `npm run build`, commit, then tag and push:

```sh
git tag -a vX.Y.Z -m "vX.Y.Z — summary"
git push origin main
git push origin vX.Y.Z
```

## License

[MIT](LICENSE)
