# opencode-pr-monitor

An [opencode](https://opencode.ai) plugin that watches GitHub pull requests in the background and delivers factual `[PR Monitor]` reports into the session that started the watch — so an agent (or you) can raise a PR, keep working, and get told when something actually happened.

## What it does

- Polls GitHub via `gh api graphql` (one query per watched PR per tick).
- Detects: CI suite conclusions, new reviews, new inline/issue comments, unresolved-thread count changes, mergeability changes, merge/close.
- Aggregates activity with a **rolling debounce**: any new activity resets a quiet timer; a report is delivered only after the PR has been quiet for the configured window.
- **CI hold**: a due report is held while a check suite is still running (bounded by `maxCiWaitMinutes`), so you get one report with the CI verdict instead of two.
- Reports are **facts only** — counts, authors, check names. No advice, no comment bodies.
- Monitors are **per-session and in-memory**: they stop automatically when the PR is merged/closed or the owning session is deleted, and they do not survive an opencode restart. Graceful opencode shutdowns deliver a stop notice to the owning session.

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
- opencode >= 1.17.

## Install

Add the plugin to your project's `opencode.json` (committed — the whole team gets it) or to your global `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["github:sesori-ai/opencode-pr-monitor#v0.1.6"]
}
```

opencode installs git-spec plugins into its package cache on startup. Pin a tag and bump it explicitly to pick up new versions.

## Usage

The plugin registers a single `pr_monitor` tool:

| Action   | `pr` argument                          | Effect |
| -------- | -------------------------------------- | ------ |
| `start`  | `owner/repo#123` or full PR URL        | Begin watching. The repo must be explicit — no cwd inference. |
| `stop`   | PR identifier or `all`                 | Stop watching. |
| `flush`  | PR identifier or `all`                 | On demand: immediately return a full status report and reset the "new since" baseline. Delivered reports already advance the baseline, so a flush after handling one isn't needed. |
| `status` | —                                      | List this session's active monitors. |

Reports arrive in the owning session as messages starting with `[PR Monitor]`.

## Configuration

Optional, per project: `.opencode/pr-monitor.json` (looked up in the project directory, then the worktree root).

```json
{
  "debounceMinutes": 5,
  "maxCiWaitMinutes": 30,
  "pollIntervalSeconds": 60,
  "ignoreCommentTag": "<!-- pr-monitor:ignore -->",
  "announceOnStart": true
}
```

| Key                   | Default | Meaning |
| --------------------- | ------- | ------- |
| `debounceMinutes`     | `5`     | Quiet window after the last detected activity before a report is delivered. Rolling — new activity resets it. |
| `maxCiWaitMinutes`    | `30`    | Upper bound on holding a due report while CI is still running. After this, the report is force-flushed naming unfinished checks. |
| `pollIntervalSeconds` | `60`    | GitHub poll interval per watched PR (minimum 30). |
| `ignoreCommentTag`    | unset   | If set, comments authored by the authenticated `gh` user that contain this tag are invisible to the monitor — useful so an agent replying to review threads doesn't trigger its own reports. |
| `announceOnStart`     | `true`  | Deliver a full status report immediately when a monitor starts, so the session sees its starting point and can address anything already outstanding on the PR. Set `false` to disable. |

## Behavior details

- **Activity** = state/mergeability changes, review changes, unresolved-thread count changes, new comments, and CI *suite conclusions*. Transitions into "running" (a new push) and per-check progress are intentionally not activity.
- **"New since last flush"** counts comments created after the watch's baseline, which advances on every delivered report or manual `flush`.
- **Failure handling**: 10 consecutive poll failures (or report-delivery failures) stop the monitor with a notice. A deleted/inaccessible PR stops it immediately.
- **Terminal states**: a report describing a merged/closed PR is delivered with a `Monitor stopped: PR merged|closed` line, then the monitor stops itself. All stop reasons (merge/close, PR deleted, repeated poll failures, plugin reload) use the same `Monitor stopped: <reason>` phrasing.
- **Shutdowns**: graceful opencode shutdowns deliver a stop notice before disposing the monitor. Abrupt process termination cannot be detected and produces no notice.

## Development

```sh
npm install
npm run typecheck
```

Layout: `core/` is the shell-agnostic core (config, polling, activity detection, the `PrWatch` state machine, report rendering) and never imports from a shell; `opencode/` is the opencode shell.

The entry point is `opencode/index.ts`; opencode executes TypeScript directly (no build step). The opencode plugin loader invokes every export of the entry module as a plugin, so `PrMonitorPlugin` must remain its sole export.

## Releasing

A release is created by pushing an annotated version tag (`vX.Y.Z`) to a commit on GitHub. There is no build, npm publication, or separate GitHub Release step. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`, commit the changes, then tag and push:

```sh
git tag -a vX.Y.Z -m "vX.Y.Z — summary"
git push origin main
git push origin vX.Y.Z
```

## License

[MIT](LICENSE)
