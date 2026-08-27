# Pull Request Monitoring

## Capability

A coding-agent session can watch explicit GitHub pull requests, receive readiness-aware `[PR Monitor]` reports when
head, review, comment, CI, mergeability, or terminal state changes, and automatically manage a handoff label.
OpenCode, Claude Code, Pi, and OMP share the same per-PR state machine and session runtime while retaining host-native
delivery and lifecycle ownership.

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
- Check contexts, latest reviews, review threads, and labels are paginated to completion before readiness is
  evaluated. A GraphQL payload containing `errors` is rejected even when it also contains partial `data` and remains
  retryable; only a clean response proving the top-level PR absent is terminal. Head changes, reviews, review
  summaries, issue comments, thread resolution, and relevant thread follow-ups count as
  activity. Stable IDs preserve same-second follow-ups. A local-account comment is an agent
  acknowledgement only when it begins with `ignoreCommentTag`; those replies remain in readiness ordering but not
  relevant-comment signatures.
- Reports contain state, counts, authors, labels, readiness, check names, changed inline-thread paths/lines and
  unique thread IDs, pending-review markers, and required workflow direction, but never comment bodies. A
  local-account comment lacking
  the prefix is identified explicitly as new human feedback rather than an earlier agent reply. Pending-review
  feedback warns that REST pull-comment results may omit it and directs the agent to inspect the listed thread via
  GraphQL before marking ready. Delivery failure restores the prior baseline and urgency. Ten consecutive poll
  failures stop with a notice; ten consecutive delivery failures stop after logging because the failed delivery
  channel cannot reliably carry a notice.
- Merge/close produces one terminal report and removes the watch. Explicit stop, session cleanup, and failed starts
  leave no timer. Cleanup drains an already-started label mutation before unregistering the watch, so a successor
  cannot race a stale add/remove; it does not wait for a stalled fetch or report delivery. A cleanup crossing an
  in-flight start still prevents late registration.

### Ready-label lifecycle

- An active watch automatically adds `readyLabel` when CI is passing or absent, mergeability is `MERGEABLE`, every
  review thread ends in a prefixed local reply, and flat issue/review-summary feedback is followed by a prefixed
  local reply. Resolution state, stale `CHANGES_REQUESTED`, pending review requests, and draft state do not block.
- A later head, relevant comment/summary, acknowledgement edit/deletion, CI regression, or definite conflict
  automatically removes readiness and flushes urgently. Resolution-only activity, approvals without summary
  feedback, transient `UNKNOWN`, merge, and close preserve it. An acknowledged state is restored only after the
  normal quiet window.
- Cross-channel comments sharing GitHub's timestamp second are conservative: readiness requires every latest tied
  entry to be a prefixed local reply. A mixed feedback/reply tie remains blocked until a later reply or manual mark.
- A review summary is feedback when its body is non-empty. An empty, comment-less `CHANGES_REQUESTED` review is also
  flat feedback; an empty review whose inline comments are represented by threads is not duplicated.
- `mark_ready` verifies an open PR, best-effort creates the green label, accepts all activity currently observed by
  an active watch without eligibility restrictions, and succeeds only after GitHub adds the label. Later activity
  still withdraws it. `unmark_ready` removes the label now but creates no persistent suppression of auto-readiness.
- Automatic mutation failure is reported truthfully and retried. Claude handoff/keep-alive follows confirmed label
  state rather than every report delivery; a readiness-preserving report does not reopen keep-alive.
- Every report and stop notice states last-known readiness. An open, unready report instructs the agent to continue
  work or use `mark_ready` when judgment says no action remains. Terminal reports preserve the label and omit that
  work instruction.

### Autonomous ownership

- The monitor owns GitHub polling and report timing. Every tool description and shipped skill forbids agent-created
  sleeps, delayed or scheduled commands, cron, background polling, repeated `gh pr checks`, and routine
  `status`/`flush` calls while waiting.
- OpenCode, Pi, and OMP end the turn and rely on native push delivery. Claude Code may run only the exact
  `await-activity.mjs` event waiter supplied by its keep-alive hook; it must not invent another waiter.
- A delivered report already advances the baseline. Agent GitHub replies begin with the configured prefix. A
  non-actionable bot acknowledgement gets no reply; the agent uses unconditional `mark_ready` instead, avoiding an
  acknowledgement loop.

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

Pi and OMP select config candidates from each `start` and standalone ready action's current cwd/trust context;
creating the session runtime with an earlier `status` call must not pin a different project. OpenCode and Claude
reread adapter-lifetime candidates for starts and standalone actions. Ready actions for an active watch use that
watch's captured label/prefix so automation and manual override cannot target different labels. An active watch keeps
its start-time config. Loading is permissive: first readable valid JSON wins, unknown keys and invalid values fall
back independently, and invalid JSON is logged before the next candidate/defaults are used. `ignoreCommentTag`
defaults to
`<!-- pr-monitor:reply -->` and matches only at the beginning of a local-account comment.

## Regression Levels

- **L1 Smoke:** Core/runtime and every adapter load; one tool and one skill are visible per host; a fake open PR can
  start, report, and stop.
- **L2 Routine:** Automated activity/readiness, acknowledgement ordering, same-account follow-ups,
  debounce/hold/urgency, report baselines, mutation/delivery retry, actions, races, and timer cleanup on Node 22
  across Linux, macOS, and Windows.
- **L3 Release:** Shared-session adapter contracts represent OpenCode, Claude, Pi, and OMP. Packed OpenCode plus
  bundled Claude checks cover owning-session delivery, reload/process lifecycle, spool/hook injection, and handoff.
- **L4 Extended:** Actual minimum and current Pi/OMP loaders, busy/idle steering, trust/config paths, successful and
  canceled transitions, and required OS rows.
- **L5 Full:** Packaged hosts against an authenticated disposable GitHub PR: initial/ordinary/urgent/terminal
  reports, handoff/withdrawal, and cleanup.

## Exploration Guidance

Vary initial versus post-start activity, same-second comments, resolved-thread follow-ups, prefixed replies,
unprefixed local-user follow-ups, bot acknowledgements, review summaries, head changes, running/concluded/no CI,
transient `UNKNOWN`, delivery failure, and casing. Cross lifecycle boundaries while a start, poll, label mutation, or
report is in flight. Vary automatic/manual add, automatic withdrawal, mutation retry, existing/missing label, plain
issue, and terminal PR.

## Failure Signals

- A report is delayed behind debounce after a new failure/conflict/terminal state, or running-CI progress creates
  repeated reports without a conclusion.
- A failed delivery advances the baseline, a same-second/thread follow-up disappears, ignored content becomes
  visible activity, or an inline-feedback report omits the changed thread's unique ID, location, or pending-review
  warning needed to distinguish new human feedback from an earlier agent reply.
- A failed label mutation changes handoff, a plain issue is labeled as a PR, a resolution-only report withdraws
  readiness, or a manual mark is immediately undone by state it explicitly accepted.
- A canceled session transition loses a watch, a successful transition retains an old timer, or an old session
  delivers into/removes readiness from a successor watch.
- An agent creates a second wait/poll mechanism, Pi/OMP fails to trigger an idle turn, or a host discovers duplicate
  `monitor-pr` skills.

## Known Limitations

- Watches and handoff state are in memory and are not restored after a host process restart.
- Multiple host processes can watch one PR but do not share an in-memory acceptance baseline. They converge through
  the GitHub label and snapshots; simultaneous manual/automatic mutations remain last-write-wins.
- Issue-comment details are limited to GitHub's latest 100 comments. Once more than 100 prefixed local replies exist,
  older replies cannot be subtracted from the repository-wide relevant total and may cause false activity.
- GitHub CLI authentication, GitHub GraphQL/REST behavior, rate limits, and external CI timing cannot be proved by
  fakes; those claims remain partial unless their L5 rows run.
- Claude delivery is necessarily spool/hook based. Desktop notifications and the supported live Claude matrix are
  macOS/Linux only; Pi/OMP use native push and do not use the Claude waiter.

## Sources

`core/watch.ts`, `core/activity.ts`, `core/readiness.ts`, `core/report.ts`, `core/github.ts`, `core/label.ts`,
`runtime/monitor-session.ts`, `runtime/tool.ts`, `opencode/index.ts`, `claude-code/src/`, `claude-code/hooks/`,
`pi/extension.ts`, `pi/index.ts`, `pi/omp.ts`, `skills/monitor-pr/SKILL.md`,
`claude-code/skills/monitor-pr/SKILL.md`, and `test/*.test.ts`.
