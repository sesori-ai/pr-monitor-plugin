# pr-monitor

A GitHub PR monitor for coding agents, available for [OpenCode](https://opencode.ai),
[Claude Code](https://code.claude.com), [Pi](https://github.com/earendil-works/pi), and
[Oh My Pi](https://omp.sh). It watches pull requests in the background, delivers `[PR Monitor]` reports into the
session that started the watch, and manages the ready-for-human-review label from observable GitHub state.

## What it does

- Polls GitHub via `gh api graphql` (one base query per watched PR per tick, plus overflow pages for checks, latest
  reviews, review threads, or labels only when needed).
- Detects: new commits, CI suite conclusions, reviews and review summaries, inline/issue comments (including
  follow-ups on existing or resolved review threads), review-thread resolution changes, mergeability changes, and
  merge/close.
- Aggregates ordinary activity with a **rolling debounce**: any new activity resets a quiet timer; a report is delivered after the PR has been quiet for the configured window.
- **Instant CI failures**: a check going red skips the debounce and the CI hold — the report goes out at the next poll, carrying whatever else was buffered, so the agent starts fixing CI instead of waiting out a timer that PR comments keep resetting.
- **Instant conflicts and terminal states**: a newly detected merge conflict, merge, or close also reports at the next poll without waiting for the debounce or CI hold.
- **CI hold**: a due report is held while a check suite is still running (bounded by `maxCiWaitMinutes`), so you get one report with the CI verdict instead of two.
- Automatically adds readiness when CI is green/absent, mergeability is `MERGEABLE`, and every feedback channel
  ends in a prefixed local-account reply. A later commit, relevant comment, CI regression, or conflict withdraws it.
- Every report states whether readiness is present and tells the agent to keep working or manually accept
  non-actionable activity. Reports include no comment bodies.
- Monitors are **per-session and in-memory**: they stop automatically when the PR is merged/closed, preserve the
  label as historical evidence, and do not survive a host restart.
- The monitor owns polling and delivers reports automatically. Agents must not create sleeps, scheduled checks, background polling loops, repeated `gh pr checks`, or routine `status`/`flush` calls while waiting.

### Example report

```
[PR Monitor] [sesori-ai/example#42](https://github.com/sesori-ai/example/pull/42) — "feat: add relay reconnect backoff"
- CI: failing (1/8 failed: analyze)
- Mergeable: MERGEABLE
- Reviews: alice ✓ approved · bob ⏳ pending
- [comment:review] 0 new relevant review summaries since last flush
- [comment:inline] ACTION REQUIRED: 2 threads received 2 new relevant comments since last flush (1 currently unresolved, 1 currently resolved; 2 coderabbitai[bot]). The unresolved-thread count is unchanged at 3; inspect every changed thread anyway.
- [comment:issue] 5 total (1 new relevant since last flush: 1 alice)
- Ready for human review: NO — label "ready-for-human-review" is absent.
- Required next step: Do more work until the PR is ready for review, or use pr_monitor(action: "mark_ready", pr: "sesori-ai/example#42") if you believe nothing else is required.
```

## Requirements

- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth status`).
- For Claude Code: Node.js >= 18 on `PATH` (runs the bundled MCP server), macOS or Linux.
- For OpenCode: OpenCode >= 1.17.
- For Pi: Pi >= 0.84.2 and Node.js >= 22.19.
- For OMP: OMP >= 18.0.3.

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
3. Agent replies begin with the configured prefix (default `<!-- pr-monitor:reply -->`). Unresolved threads may
   remain intentionally; the prefixed final reply is the acknowledgement signal.
4. The monitor automatically adds readiness when the current head is clean and withdraws it for later commits or
   feedback. Claude uses unconditional `mark_ready` only when new activity is non-actionable and should not receive
   another reply.

### How reports arrive (and how that differs from opencode)

Claude Code has no way for a background process to push a message into a session, so delivery is passive. The bundled MCP server spools finished reports, and plugin hooks inject them into the conversation at the next opportunity:

- immediately after any tool call Claude makes (`PostToolUse`),
- when you submit a prompt (`UserPromptSubmit`),
- when Claude tries to end its turn (`Stop`) — a pending report holds the turn open so Claude addresses it before going idle.

That alone still leaves a gap: a report landing while the session sits idle waits until your next message.
**Keep-alive** closes it. While a monitored PR does not carry the ready label, the `Stop` hook supplies an exact
`claude-code/hooks/await-activity.mjs` command that blocks until a report is spooled. That hook-issued command is the
only waiting mechanism Claude should run; it must never invent a delay or polling job after starting the monitor.

Bounds, so a loop can never run away:

- It ends when readiness is added automatically or manually, on `stop`, when the PR merges or closes, and when the
  MCP server goes away.
- `keepAliveMaxMinutes` (default 120) caps *idle* waiting; every delivered report refreshes it, so an active PR keeps going and an abandoned one lets go.
- <kbd>Esc</kbd> interrupts the wait like any other tool call, and asking Claude to stop wins over the loop.
- Set `"keepAlive": false` to switch the whole thing off and keep the passive-delivery behavior.

Prefer being told out of band instead? Set `desktopNotifications: true` for an OS notification when a report is waiting.

Further behavior notes for the Claude Code shell:

- Monitors belong to the Claude Code process. They survive `/clear` (the new conversation keeps receiving reports) and die with the process; they do not survive quitting Claude Code or `claude --resume` into a new process. If the MCP server is restarted while Claude Code keeps running (e.g. `/reload-plugins`), each active monitor delivers a `Monitor stopped` notice; when Claude Code itself exits, monitors simply die with it (no notice — there is no session left to deliver to).
- Config first uses repository `.pr-monitor.json`, then falls back to `.claude/pr-monitor.json` and `.opencode/pr-monitor.json`.

## opencode

### Install

Add the plugin to your project's `opencode.json` (committed — the whole team gets it) or to your global `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

opencode installs npm plugins and their dependencies into its package cache on startup. To make upgrades explicit, pin a version such as `@sesori/pr-monitor-opencode@0.3.1` and bump it deliberately. Quit and restart opencode after changing the plugin configuration.

Reports arrive in the owning session as messages starting with `[PR Monitor]`. Monitors stop when the owning session is deleted. On graceful opencode shutdown, a no-reply stop notice is persisted to each owning session before the plugin is disposed, so it is present in history when opencode starts again.

The package injects its `monitor-pr` skill through OpenCode's skill-path config, so the agent learns the complete ownership loop without a consuming repository copying the skill.

## Pi and OMP

Install the shared package in Pi:

```sh
pi install npm:@sesori/pr-monitor-pi
```

Or in OMP:

```sh
omp plugin install @sesori/pr-monitor-pi
```

The package selects the correct entry automatically and supplies one `monitor-pr` skill to each host. Reports use native custom-message delivery with steering and idle turn triggering, so agents end the turn while waiting and wake only for real activity. Pi clears watches after successful session replacement/reload shutdown; OMP clears them on its post-success session-switch event. Canceled transitions retain the active watch.

## The `pr_monitor` tool

All four harnesses register the same tool:

| Action   | `pr` argument                          | Effect |
| -------- | -------------------------------------- | ------ |
| `start`  | `owner/repo#123` or full PR URL        | Begin watching. The repo must be explicit — no cwd inference. |
| `stop`   | PR identifier or `all`                 | Stop watching. |
| `flush`  | PR identifier or `all`                 | On demand: immediately return a full status report and reset the "new since" baseline. Delivered reports already advance the baseline, so a flush after handling one isn't needed. |
| `status` | —                                      | List this session's active monitors. |
| `mark_ready` | `owner/repo#123` or full PR URL    | Unconditionally accept current observed state and add `readyLabel`. Use for non-actionable bot acknowledgements or other judgment calls that should not receive a reply. Creates the label if needed and releases Claude keep-alive. Standalone actions still require an open PR. |
| `unmark_ready` | `owner/repo#123` or full PR URL  | Remove the label now. It is idempotent and is not a permanent hold: an active monitor may restore readiness after a later clean assessment. |

## Configuration

Optional, per project: use `.pr-monitor.json` for every host. Claude Code falls back to `.claude/pr-monitor.json` then `.opencode/pr-monitor.json`; OpenCode falls back to `.opencode/pr-monitor.json`; Pi/OMP use their `CONFIG_DIR_NAME` (`.pi`/`.omp`) before `.opencode/pr-monitor.json`. Pi reads project-local config only after project trust.

```json
{
  "debounceMinutes": 2,
  "maxCiWaitMinutes": 30,
  "pollIntervalSeconds": 60,
  "ignoreCommentTag": "<!-- pr-monitor:reply -->",
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
| `ignoreCommentTag`     | `<!-- pr-monitor:reply -->` | Mandatory prefix for agent-authored GitHub replies. A local-account comment without this exact starting prefix is treated as human feedback; prefixed replies remain private acknowledgement evidence and do not count as new relevant comments. |
| `announceOnStart`      | `true`  | Deliver a full status report immediately when a monitor starts, so the session sees its starting point and can address anything already outstanding on the PR. Set `false` to disable. |
| `flushOnCiFailure`     | `true`  | Report a newly failing check at the next poll instead of waiting out `debounceMinutes` (and any CI hold), so CI fixes start sooner. Counts failures found while the suite is still running. At most one instant report per head commit — later failures on the same commit ride along with the debounced suite-conclusion report. Set `false` for debounce-only delivery. |
| `desktopNotifications` | `false` | Claude Code only: emit an OS notification (macOS/Linux) when a report is spooled, so an idle session's reports aren't silently waiting. |
| `readyLabel`           | `ready-for-human-review` | Label managed automatically by active watches and explicitly by `mark_ready`/`unmark_ready`. |
| `keepAlive`            | `true`  | Claude Code only: while a monitored PR lacks the ready label, refuse turn-end and have Claude wait for the next report. Set `false` for passive delivery. |
| `keepAliveMaxMinutes`  | `120`   | Claude Code only: cap on how long the keep-alive loop waits with *nothing happening*. Refreshed by every delivered report, so it bounds idle time rather than total work time. |

## Behavior details

- **Activity** = head changes, state/mergeability changes, review changes, per-thread resolution or relevant-comment
  changes, issue comments, and CI *suite conclusions*. A head change is activity even before GitHub registers checks;
  non-failing per-check progress on the same head remains quiet.
- **CI failures bypass the timers** (`flushOnCiFailure`, default on). A check whose outcome is newly `failure` — including one found while the suite is still running, which is otherwise not activity — flushes on the spot: no quiet window, no CI hold. The report reads the suite honestly (`- CI: running (3/8 done, 1 failed so far: lint)`). The instant path fires at most once per head commit, so a matrix going red job by job cannot wake the session once per job; the suite's eventual conclusion still delivers the full verdict through the normal debounce, and the next push re-arms the instant path.
- **Conflicts and terminal states bypass the timers.** A newly observed `CONFLICTING` state (including an `UNKNOWN -> CONFLICTING` settle), merge, or close reports at the next poll and is never held behind running CI.
- **Review-thread follow-ups are explicit.** Reports lead with `ACTION REQUIRED` when any existing or resolved thread
  receives a relevant comment and explicitly warn that the unresolved count may be unchanged. Local-account comments
  lacking the mandatory prefix are identified as human feedback.
- **Readiness follows acknowledgement, not resolution.** Each review thread may remain unresolved if its latest
  comment is a prefixed local reply. Flat issue/review-summary feedback is acknowledged by a later prefixed local
  issue comment. Editing or deleting that acknowledgement withdraws readiness. Mixed feedback/reply entries in the
  same timestamp second remain conservatively blocked until a later reply or manual mark. Stale `CHANGES_REQUESTED`,
  pending reviewers, thread resolution, and draft status do not independently block readiness.
- **"New since last flush"** compares stable GitHub comment IDs with the last delivered report or manual `flush`, so comments created within the same timestamp second are not lost.
- **Failure handling**: 10 consecutive poll failures (or report-delivery failures) stop the monitor with a notice. A failed initial status report retains its zero comment baseline and retries at the next poll. A deleted/inaccessible PR stops immediately.
- **Terminal states**: an immediate report describing a merged/closed PR is delivered with a `Monitor stopped: PR merged|closed` line, then the monitor stops itself. All stop reasons use the same `Monitor stopped: <reason>` phrasing.

## Development

```sh
npm install
npm test             # core, shared runtime, and adapter regression tests
npm run typecheck    # core + runtime + all adapters
npm run build        # OpenCode/Pi publish bundles + committed Claude MCP bundle
npm run version:check
npm run pack:check   # inspect/install/import both npm artifacts
npm run host:check   # load the Pi and OMP bundles through their real loaders
npm run clean        # remove ephemeral OpenCode/Pi build and generated skill output
```

Layout — one directory per target, plus shared core/runtime layers:

```
core/            per-PR state, config, GitHub normalization, activity, reports
runtime/         session registry/actions/timers, Node gh runner, shared tool contract
skills/          canonical monitor-pr skill for push-capable hosts
opencode/        OpenCode adapter and npm workspace
pi/              shared Pi/OMP adapter entries and npm workspace
claude-code/     Claude Code shell — this directory is the plugin root (${CLAUDE_PLUGIN_ROOT})
.claude-plugin/  marketplace.json, which stays at the repo root and points at ./claude-code
```

Dependency flows adapter → `runtime/` → `core/`; core imports no host SDK and runtime owns common session orchestration. The root is a private npm workspace coordinator. OpenCode source stays in `opencode/`, but publication bundles it with private core/runtime into `opencode/dist/index.js`; both `.` and `./server` resolve to that sole-export bundle. Its tarball contains only the bundle and declaration, target README/license, and manifest; generated OpenCode output stays uncommitted. The Claude Code shell is bundled with esbuild into the committed `claude-code/dist/mcp-server.mjs`, since Git plugin installs run no build step; `claude-code/hooks/drain-spool.mjs` is the dependency-free hook that injects spooled reports and runs the keep-alive loop, and `claude-code/hooks/await-activity.mjs` is the blocking waiter it hands to the session; `claude-code/skills/monitor-pr/` is the behavior — when to start a monitor, what to do with each report, when to hand off; `claude-code/.mcp.json` declares the MCP server (plugin-root convention — an inline `mcpServers` field in plugin.json is not picked up).

## Regression coverage

Durable acceptance criteria live in [`docs/regression/`](docs/regression/README.md):

- [`pull-request-monitoring.md`](docs/regression/pull-request-monitoring.md) covers shared watch semantics,
  ready-label handoff, autonomous delivery, host lifecycle, and configuration.
- [`plugin-installation.md`](docs/regression/plugin-installation.md) covers exact npm/Claude artifacts, host floors,
  skill discovery, loader compatibility, and lockstep release metadata.

The catalogs distinguish automated, adapter, actual-host, and packaged/external proof. Do not treat a source import
or fake adapter as proof of a packed host integration.

## Releasing

A release uses one version for all targets. The OpenCode workspace publishes `@sesori/pr-monitor-opencode`; the
Pi workspace publishes the shared Pi/OMP package `@sesori/pr-monitor-pi`; and the annotated `vX.Y.Z` tag marks the
Claude Code Git-plugin release. The private root cannot be published, and there is no separate GitHub Release step.

Update both workspace manifests and lock entries, `claude-code/.claude-plugin/plugin.json`, the MCP server version,
and `CHANGELOG.md`. From a clean candidate commit, complete the full matrix before publishing:

```sh
npm ci
npm run release:check # tests, types, builds, versions, exact packs, Pi floor, OMP floor
OPENCODE_CLI="$(command -v opencode)" npm run host:check:opencode
OMP_VERSION=18.0.4 npm run host:check:omp
# Also complete the live Claude release-host row documented in docs/regression/plugin-installation.md.
git diff --exit-code -- claude-code/dist/mcp-server.mjs
```

Use the current supported OpenCode/OMP versions for the two current-host rows; CI records Linux/macOS coverage while
Windows runs the required package/loader smoke. After the candidate PR merges, use a clean checkout of that exact
`main` commit. Publish both npm artifacts before creating the Claude tag, so an npm rejection cannot leave a stale
cross-harness release marker:

```sh
npm whoami
npm publish --workspace @sesori/pr-monitor-opencode --access public
npm publish --workspace @sesori/pr-monitor-pi --access public
npm view @sesori/pr-monitor-opencode@X.Y.Z version
npm view @sesori/pr-monitor-pi@X.Y.Z version
git tag -a vX.Y.Z -m "vX.Y.Z — summary"
git push origin vX.Y.Z
```

The first Pi/OMP publication requires permission to create public packages in the `@sesori` scope (`npm login` if
needed). `publishConfig` already fixes npmjs.org and public access. npm versions are immutable: never tag Claude or
retry a changed tarball under the same version until both npm registry checks above succeed.

## License

[MIT](LICENSE)
