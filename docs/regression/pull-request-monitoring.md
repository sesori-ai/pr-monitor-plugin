# Pull Request Monitoring

## Capability

A coding-agent session can watch explicit GitHub pull requests and receive factual `[PR Monitor]` reports when
review, comment, CI, mergeability, or terminal state changes. OpenCode, Claude Code, Pi, and OMP share the same
per-PR state machine and session runtime while retaining host-native delivery and lifecycle ownership.

The highest required regression level is **L5 Full** because the complete claim crosses published artifacts, real
host loaders, authenticated GitHub state, and ready-label mutation.

## Required Behavior

### Watch and report semantics

- `start` accepts `owner/repo#number` or a full GitHub pull-request URL, rejects non-open targets, deduplicates
  owner/repository casing within one session, delivers the initial snapshot by default, and starts one owned timer.
- `status`, `flush`, `stop`, `mark_ready`, and `unmark_ready` expose the same action contract in every host. Label
  actions do not require an active watch; watch actions never infer a target from the current directory.
- Ordinary activity is debounced from the latest visible change. A due report waits for running CI only up to
  `maxCiWaitMinutes`. Entering CI `running` and non-failing per-check progress are not ordinary activity.
- With `flushOnCiFailure` enabled, a newly failing check is urgent and bypasses both debounce and the CI hold.
  Newly definite merge conflict, merge, and close are always urgent. Instant CI failure is limited to one delivery
  per head commit; the concluded suite can report later.
- Reviews, issue comments, thread resolution, and visible review-thread follow-ups count as activity. Stable comment
  IDs preserve same-second follow-ups, and ignored tagged self-comments do not alter visible signatures.
- Reports contain state, counts, authors, labels, and check names, never comment bodies or advice. Delivery failure
  restores the prior baseline and urgency. Ten consecutive poll failures stop with a notice; ten consecutive
  delivery failures stop after logging because the failed delivery channel cannot reliably carry a notice.
- Merge/close produces one terminal report and removes the watch. Explicit stop, session cleanup, and failed starts
  leave no timer. A lifecycle cleanup that crosses an in-flight start wins, so that start cannot register late.

### Ready-label handoff

- `mark_ready` first verifies that the named target is an open pull request, best-effort creates the configured green
  label, and succeeds only after GitHub accepts adding the label to the PR.
- Claude Code records handoff and releases keep-alive only after that success. Label failure leaves the monitor active
  for diagnosis and retry. An already existing label is a valid idempotent success.
- `unmark_ready` verifies the same open-PR boundary and treats a missing label as success. New feedback after handoff
  requires withdrawing readiness before work resumes.
- Label changes are visible in reports but are not monitor activity; otherwise the agent's own handoff would wake the
  same loop immediately.

### Autonomous ownership

- The monitor owns GitHub polling and report timing. Every tool description and shipped skill forbids agent-created
  sleeps, delayed or scheduled commands, cron, background polling, repeated `gh pr checks`, and routine
  `status`/`flush` calls while waiting.
- OpenCode, Pi, and OMP end the turn and rely on native push delivery. Claude Code may run only the exact
  `await-activity.mjs` event waiter supplied by its keep-alive hook; it must not invent another waiter.
- A delivered report already advances the baseline. The agent handles the report, ends the turn when more external
  activity is needed, and calls `mark_ready` only when CI/reviews/comments/mergeability are genuinely clean.

## Required Host Rows

### OpenCode 1.17 or newer

- `PrMonitorPlugin` is the only package export and registers one `pr_monitor` tool.
- Normal delivery uses `promptAsync` in the owning session with the start-time agent and latest captured model.
  Server errors surfaced in `result.error` count as delivery failures.
- Session deletion stops silently. Reload takeover stops prior-instance timers with notices. Graceful disposal uses
  synchronous no-reply prompts so notices are persisted without starting a model turn.
- The packaged push-host skill is injected exactly once through `config.skills.paths`.

### Claude Code with Node.js 18 or newer on macOS/Linux

- The MCP process spools one file per report under the owning Claude process identity. Hooks claim reports exactly
  once, do not let Task subagents consume them, and inject them on prompt, tool completion, or turn end.
- Keep-alive publishes a liveness heartbeat and rolling idle deadline. It ends on confirmed handoff, stop, terminal
  state, MCP death, or idle expiry; only its exact event waiter may block.
- `/clear` retains process-owned watches. Process exit loses them. MCP restart spools factual stop notices when the
  owning process remains able to receive them.
- Claude discovers exactly one conventional waiter-aware `monitor-pr` skill.

### Pi 0.84.2 or newer with Node.js 22.19 or newer

- The package registers one tool and delivers custom `pr-monitor` messages with
  `{ deliverAs: "steer", triggerTurn: true }` while both busy and idle.
- Post-success `session_shutdown` clears all watches for new/resume/fork/reload/quit. Canceled before-events do not
  clear anything, and a stopped instance cannot deliver or remove a successor's watch.
- Project config is read only after Pi marks the project trusted. Manifest-owned discovery supplies exactly one
  packaged push-host skill.

### OMP 18.0.3 or newer

- The OMP entry delegates all monitoring and delivery to the shared Pi-family implementation after compatibility
  import rewriting.
- Post-success `session_switch` clears watches for new/resume/fork; process `session_shutdown` clears remaining
  watches. Canceled before-events retain the active watch.
- `resources_discover` returns exactly one packaged skill path. It must not duplicate Pi manifest discovery.

## Configuration Matrix

All hosts prefer repository `.pr-monitor.json`. Remaining candidates are evaluated in this order:

- OpenCode: project/worktree `.opencode/pr-monitor.json` fallbacks.
- Claude Code: `.claude/pr-monitor.json`, then `.opencode/pr-monitor.json`.
- Trusted Pi and OMP: `${CONFIG_DIR_NAME}/pr-monitor.json`, then `.opencode/pr-monitor.json`.
- Untrusted Pi: defaults only; no project-local monitor file is read.

Config for `start`, `mark_ready`, and `unmark_ready` is loaded from that action's current cwd/trust context; creating
the session runtime with an earlier `status` call must not pin a different project. An active watch keeps the config
captured when it started. Loading is permissive: first readable valid JSON wins, unknown keys and invalid values fall
back independently, and invalid JSON is logged before the next candidate/defaults are used.

## Regression Levels

- **L1 Smoke:** Core/runtime and every adapter load; one tool and one skill are visible per host; a fake open PR can
  start, report, and stop.
- **L2 Routine:** Automated activity, debounce/hold/urgency, report baselines, retry rollback, action validation,
  labels, races, and timer cleanup.
- **L3 Release:** Packed OpenCode plus bundled Claude adapter contracts: owning-session delivery, reload/process
  lifecycle, spool/hook injection, and handoff.
- **L4 Extended:** Actual minimum and current Pi/OMP loaders, busy/idle steering, trust/config paths, successful and
  canceled transitions, and required OS rows.
- **L5 Full:** Packaged hosts against an authenticated disposable GitHub PR: initial/ordinary/urgent/terminal
  reports, handoff/withdrawal, and cleanup.

## Exploration Guidance

Vary initial versus post-start activity, same-second comments, resolved-thread follow-ups, ignored self-replies,
running versus concluded CI, transient `UNKNOWN` mergeability, delivery failure, and case variants of one target.
Cross lifecycle boundaries while a start, poll, or report is in flight. For ready handoff, vary missing/existing label,
GitHub mutation failure, already-labeled PR, missing label removal, plain issue, and merged PR.

## Failure Signals

- A report is delayed behind debounce after a new failure/conflict/terminal state, or running-CI progress creates
  repeated reports without a conclusion.
- A failed delivery advances the baseline, a same-second/thread follow-up disappears, or ignored content becomes
  visible activity.
- A failed label mutation releases Claude keep-alive, a plain issue is labeled as a PR, or readiness itself wakes the
  monitor.
- A canceled session transition loses a watch, a successful transition retains an old timer, or an old session
  delivers into/removes a successor watch.
- An agent creates a second wait/poll mechanism, Pi/OMP fails to trigger an idle turn, or a host discovers duplicate
  `monitor-pr` skills.

## Known Limitations

- Watches and handoff state are in memory and are not restored after a host process restart.
- A bare head-SHA push is not activity. A later CI conclusion, review/comment, conflict, or terminal change reports;
  a CI-less push without another visible event does not wake a handed-off session.
- GitHub CLI authentication, GitHub GraphQL/REST behavior, rate limits, and external CI timing cannot be proved by
  fakes; those claims remain partial unless their L5 rows run.
- Claude delivery is necessarily spool/hook based. Desktop notifications and the supported live Claude matrix are
  macOS/Linux only; Pi/OMP use native push and do not use the Claude waiter.

## Sources

`core/watch.ts`, `core/activity.ts`, `core/report.ts`, `core/github.ts`, `core/label.ts`,
`runtime/monitor-session.ts`, `runtime/tool.ts`, `opencode/index.ts`, `claude-code/src/`, `claude-code/hooks/`,
`pi/extension.ts`, `pi/index.ts`, `pi/omp.ts`, `skills/monitor-pr/SKILL.md`,
`claude-code/skills/monitor-pr/SKILL.md`, and `test/*.test.ts`.
