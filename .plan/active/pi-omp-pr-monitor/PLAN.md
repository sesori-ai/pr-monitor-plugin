# Pi And OMP PR Monitor Support

## Status

- **Plan slug:** `pi-omp-pr-monitor`
- **Status:** Step 1/6, planning PR
- **Plan date:** 2026-08-23
- **Implementation base:** `origin/main` at `af612132995aac6e48b52c7c35dd3d133d08ce82`
- **Host research baselines:** Pi `0.84.2`, OMP `18.0.3`, OpenCode `>=1.17.0`, and Claude Code plugin
  behavior already documented in this repository
- **Repository:** `sesori-ai/opencode-pr-monitor`
- **Delivery:** six sequential PRs: plan/skills, shared runtime, distribution workspaces, Pi/OMP adapter,
  regression documentation, and verification/retirement

## Goal

Add the PR monitor to Pi and Oh My Pi (OMP) without duplicating the watch state machine or creating a
repository per harness. The repository becomes one source workspace with a pure monitoring core, one
session-level application runtime, and thin host adapters. OpenCode and Pi are separate npm artifacts;
Pi and OMP intentionally share one upstream-Pi-compatible extension; Claude Code retains its native MCP,
spool, hooks, and plugin-marketplace distribution.

The result must preserve the existing OpenCode and Claude Code behavior while making another harness adapter
a small, explicit integration rather than another copy of start/stop/config/timer logic.

## Success Criteria

1. `core/` has no imports from OpenCode, Claude Code, Pi, OMP, MCP, or another host SDK.
2. `runtime/` owns the session-scoped watch registry, common actions, GitHub-user resolution, timer lifecycle,
   and label operations used by all three adapter families.
3. OpenCode keeps session-specific delivery, current-model capture, reload takeover, synchronous shutdown
   persistence, and `session.deleted` cleanup.
4. Claude Code keeps PID/start-token spool ownership, hook delivery, handoff state, keep-alive, desktop
   notifications, and committed MCP bundle behavior.
5. One Pi-family implementation registers `pr_monitor`, delivers reports with native
   `pi.sendMessage(..., { triggerTurn: true })`, and clears all timers after every successful session replacement
   and shutdown without clearing them when a cancelable replacement is declined.
6. The same package loads in OMP through a thin lifecycle/resource entrypoint around the shared implementation.
   There is no second OMP monitor implementation, watch registry, or npm package.
7. Pi loads project configuration only for a trusted project. OMP uses its documented always-trusted
   compatibility result. Both resolve the host config directory through `CONFIG_DIR_NAME`, never a hardcoded
   `.pi` or `.omp` branch.
8. Pi and OMP each discover the same package-owned `monitor-pr` skill exactly once. It teaches the full ownership
   loop without Claude-only spool/keep-alive instructions.
9. Every shipped skill and tool description says that the monitor owns polling and reports arrive automatically.
   Agents must never invent sleeps, delayed/scheduled jobs, polling loops, or routine `status`/`flush` calls while
   waiting for CI/review. Claude may run only the exact event waiter supplied by its keep-alive hook; Pi/OMP end
   the turn and let `sendMessage` wake them.
10. A clean PR is handed off only after `mark_ready` confirms that GitHub accepted the label. Label failure never
    records Claude handoff or releases keep-alive, and the skill requires diagnosis/retry rather than claiming ready.
11. `@sesori/pr-monitor-opencode` remains install-compatible, including its `.` and `./server` exports, while
    `@sesori/pr-monitor-pi` is independently installable by Pi and OMP.
12. Neither npm artifact depends on a separately published core package. The private core/runtime are bundled
    into each artifact, so internal refactors cannot create package-version skew.
13. The root is non-publishable and coordinates builds, tests, package inspection, and one lockstep product
    version across both npm artifacts and the Claude Code manifest.
14. Packed-artifact and real-host verification covers OpenCode, Claude Code, Pi, and OMP before retirement.

## Current Behavior And Evidence

### The watch core is strong but not fully host-independent

- `core/watch.ts` contains the tested per-PR state machine: serialized poll/flush operations, rolling debounce,
  CI hold, urgent failures/conflicts/terminal states, delivery rollback, and terminal cleanup.
- `core/activity.ts`, `core/report.ts`, `core/target.ts`, and the snapshot normalization in `core/github.ts` are
  reusable as written.
- `core/github.ts` nevertheless imports `PluginInput` from `@opencode-ai/plugin` solely to implement
  `createGhRunner`. This contradicts the documented dependency direction and prevents core from being host-free.
- `PrWatch.sessionID` is registry ownership metadata. The state machine does not use it to detect or report PR
  activity.
- `core/config.ts` combines common monitor values with Claude-only `desktopNotifications`, `keepAlive`, and
  `keepAliveMaxMinutes` values.

### Session orchestration is duplicated

`opencode/index.ts` and `claude-code/src/mcp-server.ts` each implement their own:

- target parsing, watch selection, duplicate checks, and the post-await duplicate-start recheck;
- config loading and authenticated `gh` login resolution for `ignoreCommentTag`;
- initial snapshot validation and `PrWatch` construction;
- interval setup/removal and stop/flush/status action routing; and
- ready-label calls and error formatting.

Those are application-level monitor-session responsibilities, not delivery transport. The duplication is now
large enough that a third copy would be a maintenance defect.

### Delivery genuinely differs by host

- OpenCode pushes a user message to a named session with the start-time agent and latest captured model. Its
  asynchronous endpoint reports server errors in `result.error`, and shutdown must use synchronous `prompt`
  with `noReply: true`.
- Claude Code has no push channel. Its MCP process atomically spools reports, while dependency-free hooks claim
  and inject them and run the bounded keep-alive loop.
- Pi supports custom extension messages that participate in model context. `pi.sendMessage` can queue while the
  agent is busy and start a turn when idle, so Pi needs neither MCP nor a spool.
- OMP `18.0.3` rewrites imports from `@earendil-works/pi-*`, remaps TypeBox, and accepts `package.json#pi` or
  `package.json#omp`. Unlike upstream Pi, it retains the extension runner across `/new`, `/resume`, and `/fork`
  and emits post-success `session_switch`; `session_shutdown` remains process teardown.

Delivery and host lifecycle therefore remain adapter-owned. They are ports into a shared monitor session, not a
reason to generalize every host through MCP.

### Distribution is currently asymmetric

- The root `package.json` is the published OpenCode package and allowlists `core/` plus `opencode/`.
- Claude Code is a separate Git distribution rooted at `claude-code/`, with a committed esbuild bundle and a
  root marketplace pointer.
- There is no safe place to add another independently named npm artifact while the repository root itself is the
  OpenCode artifact.

## Locked Design Decisions

### One repository, separate artifacts

Keep one repository. Split source and release concerns inside it rather than splitting Git history:

```text
core/                  pure per-PR domain/state machine
runtime/               host-neutral session orchestration and Node gh runner
opencode/              OpenCode source plus @sesori/pr-monitor-opencode package metadata
pi/                    shared implementation, thin Pi/OMP entries, skill, and npm package metadata
claude-code/           Claude Code plugin root, MCP source, hooks, commands, skill, committed bundle
scripts/               workspace build, package-content, and version checks
```

The root becomes a private npm workspace coordinator. `opencode/` and `pi/` are publishable workspaces.
`claude-code/` remains in its required plugin-root shape rather than being forced into an npm abstraction.

A public `@sesori/pr-monitor-core` package is explicitly excluded. There is no external consumer and no reason to
promise a stable library API. esbuild follows imports into `core/` and `runtime/` and embeds them in each target.

### Dependency direction

```text
OpenCode adapter ─┐
Pi/OMP adapter ───┼──> runtime/ ──> core/
Claude adapter ───┘

core/     imports no host or runtime module
runtime/  imports core and Node standard-library modules only
adapters  import runtime/core and their own host SDK
```

`runtime/node-gh.ts` has two current consumers: Claude Code and Pi/OMP. OpenCode retains a local `opencode/gh.ts`
because its injected Bun shell has materially different result/error semantics.

### `MonitorSession` ownership

Add `runtime/monitor-session.ts` with one `MonitorSession` per logical agent session. It owns:

- `targetKey -> { PrWatch, timer, report channel, resolved config }`;
- the session's lazily resolved authenticated GitHub login;
- common start, stop, flush, status, `mark_ready`, and `unmark_ready` behavior;
- duplicate-start rechecking after asynchronous config/GitHub work;
- interval creation and identity-safe cleanup; and
- normal, notice-bearing, and shutdown cleanup over a snapshot of active watches.

A start call receives a small per-watch report-channel factory. The resulting channel has normal delivery and an
optional shutdown-persistence delivery. This is necessary for OpenCode's agent/model capture and shutdown
endpoint, Claude's target/config-aware spool side effects, and Pi's native message delivery. The runtime does not
know which host supplied a channel.

The runtime returns structured start/ready results containing the target, config, initial snapshot, and factual
base text. Adapters add only truthful host delivery/lifecycle wording. Claude's handed-off set and keep-alive
state stay in `claude-code/`; the shared session exposes target presence and a status-line decoration seam rather
than owning Claude policy. The existing Claude invariant is locked: add the GitHub label first, record handoff only
on success, and leave keep-alive armed on failure. Idempotent label addition remains success.

`PrWatch` keeps only per-PR state and drops `sessionID`. No generic event bus, daemon, persistent registry, or
cross-process coordinator is added.

### Configuration

Split configuration into:

- common watch/action config used by core/runtime: debounce, CI wait, poll interval, ignored-comment tag,
  startup announcement, instant CI failure, and ready label; and
- Claude delivery config: desktop notifications, keep-alive, and idle cap.

All hosts first accept a repository-level `.pr-monitor.json` so one project can configure the product once.
Existing `.opencode/pr-monitor.json` and `.claude/pr-monitor.json` locations remain ordered fallbacks. Pi/OMP also
accept `${CONFIG_DIR_NAME}/pr-monitor.json`, which becomes `.pi` under Pi and `.omp` under OMP. The loader retains
its permissive unknown/invalid-key behavior; no migration or compatibility copy is written.

Pi checks `ctx.isProjectTrusted()` before considering project-local paths. An untrusted project uses defaults and
never reads a local monitor config. OMP's compatibility implementation returns true because OMP already loads
project resources without Pi's trust gate.

### Pi-family adapter and lifecycle seam

Keep tool, delivery, config, and monitor ownership in one shared Pi-family implementation. `pi/index.ts` is the
upstream entry and uses only documented `@earendil-works/pi-coding-agent` APIs: TypeBox/StringEnum `registerTool`,
`session_start`, `session_shutdown`, `sendMessage`, `CONFIG_DIR_NAME`, and `isProjectTrusted`.

Upstream Pi emits `session_shutdown` for the old extension instance only after a successful `/new`, `/resume`,
`/fork`, `/clone`, or reload transition, then binds a fresh instance and emits `session_start`. Cleanup therefore
belongs in an idempotent shutdown handler, not `session_before_switch`/`session_before_fork`: those events can cancel,
and clearing there would kill valid watches when the user stays in the old session.

OMP `18.0.3` has a material lifecycle difference: it retains its extension runner and emits post-success
`session_switch` for `new|resume|fork`, while `session_shutdown` is process teardown. `pi/omp.ts` is a thin package
entrypoint that delegates all monitor behavior to the same shared factory and additionally maps `session_switch` to
session disposal/reinitialization. It owns no watch logic or state. Separate entries avoid runtime host detection and
make the one unavoidable compatibility seam independently testable.

Do not use OMP-only schemas, managed jobs, daemon supervision, MCP, or hooks. Use ordinary timers only inside
`MonitorSession`; both entries synchronously and idempotently dispose the current session owner at their successful
replacement/teardown boundary. The shared tool description explicitly prohibits agent-created sleeps, scheduled
checks, polling loops, and routine `status`/`flush`: reports are autonomous, so Pi/OMP end the turn when idle.

The package declares both entries:

```json
{
  "pi": {
    "extensions": ["./dist/index.js"],
    "skills": ["./skills"]
  },
  "omp": {
    "extensions": ["./dist/omp.js"]
  }
}
```

OMP receives the same skill through its entry's `resources_discover`; Pi receives it through the native package
manifest. Each loader sees it exactly once.

### Packaging and release

- Bundle OpenCode to ESM while leaving `@opencode-ai/plugin` external and declared as its runtime dependency.
- Bundle Pi/OMP to ESM while leaving Pi host packages and TypeBox external as peer dependencies, per Pi package
  guidance. OMP resolves those peers through its compatibility loader.
- Keep only target bundle, target README, license, and required skill files in each npm tarball.
- Do not commit OpenCode/Pi npm bundles; build and inspect them during test/prepack. Continue committing only the
  Claude Code bundle because Git plugin installs run no build step.
- Preserve `@sesori/pr-monitor-opencode` and its `.`/`./server` exports. Add
  `@sesori/pr-monitor-pi`; do not publish a duplicate `-omp` alias.
- Keep one product version across the two npm manifests and
  `claude-code/.claude-plugin/plugin.json`. A root check fails on drift.
- Publish npm artifacts independently from their workspaces. The existing Git tag remains the Claude Code release
  marker. Publication itself remains the normal release operation after this implementation series; no test step
  publishes an unverified package.

### No universal MCP or long-lived daemon

MCP standardizes invoking a tool, not delivering an unsolicited report to the owning conversation. Reusing the
Claude MCP/spool path in Pi would lose Pi's native push and add process routing, persistence, and cleanup with no
product benefit. A standalone monitor daemon would also require session ownership, authentication, protocol, and
upgrade state that the in-process host already supplies.

Those designs are excluded unless a future host has no native lifecycle and at least one additional real consumer
justifies them.

## Complexity Budget

### New persistent mutable state

None in production. The change adds package manifests, generated publish-time bundles, a skill, tests, and planning
or regression documents. Watches remain deliberately in-memory and session-scoped. No database, disk registry,
spool, lock, PID record, config migration, or durable watch restoration is added for Pi/OMP.

### New in-memory mutable state

- One `MonitorSession` watch map and cached authenticated login per logical host session. This replaces the existing
  adapter maps/login fields for OpenCode and Claude rather than layering another registry over them.
- OpenCode gains `sessionID -> MonitorSession` because one plugin instance hosts multiple sessions; this replaces
  its current composite `${sessionID} ${targetKey}` map and has the same ownership cardinality.
- Pi/OMP gains one `MonitorSession` for the active extension session, which is the minimum owner for its watches.
- Claude's existing handed-off set and keep-alive deadlines remain unchanged and are not copied into runtime.

### Deliberately not added

- public core/runtime npm packages;
- separate Pi and OMP monitor implementations or packages;
- cross-host base classes beyond the three-consumer `MonitorSession` boundary;
- watch persistence across host restart, `/resume`, or process replacement;
- a background daemon, MCP bridge, report spool, delivery retry queue, or filesystem watcher for Pi/OMP;
- runtime host detection or OMP branches inside shared monitor logic; and
- new convenience commands before the common tool and package skill prove sufficient.

### Evidence and accepted risk

- Timer cleanup addresses ordinary `/new`, `/resume`, `/fork`, `/reload`, and quit flows. Upstream Pi uses
  post-success shutdown/rebind; OMP uses its post-success switch event. Cancelable before-events never clear state.
- Duplicate-start rechecking preserves an already demonstrated concurrent request path from the Claude MCP server.
- Project trust protects an ordinary globally installed Pi extension from honoring untrusted local configuration.
- OMP compatibility drift is plausible because it is an independently released fork. Release verification pins a
  supported floor and current release, but production does not add a second fallback implementation.
- `sendMessage` accepts a report synchronously but has no remote durability acknowledgement. A successful call is
  treated as delivery acceptance, matching Pi's extension contract. Session shutdown may end before a queued model
  turn; no persistence mechanism is added solely to eliminate that bounded lifecycle behavior.

## Cleanup Assessment

Directly caused cleanup is part of Steps 2 and 3:

- move `createGhRunner` out of `core/github.ts`;
- move the reusable child-process runner out of `claude-code/src/gh.ts`;
- remove `PrWatch.sessionID`;
- replace duplicated watch/action/timer/login/label orchestration in both existing adapters;
- split Claude-only config from common monitor config; and
- move OpenCode publish metadata out of the root package so the root cannot accidentally publish one target as the
  whole product.

No Claude spool, hook, owner token, keep-alive file, command, or skill becomes obsolete; those exist because Claude
lacks native push. No report/activity/state-machine behavior is replaced. Renaming the GitHub repository is deferred
because repository redirects and branding provide no implementation benefit to Pi/OMP support.

## Delivery Rules

- `TRACKER.md` is canonical for the fixed six titles, complexity ratings, line targets, order, and state.
- Every PR targets `main`, merges in numeric order, and remains independently testable.
- Keep changed lines below the 1,500-line soft cap. If generated lockfile or test output makes a coherent step exceed
  it, split before opening the PR or record why no independently valid split exists.
- Rebuild and commit `claude-code/dist/mcp-server.mjs` whenever shared runtime/core or Claude source changes. Review
  source, not the generated bundle.
- Do not hand-edit generated bundles or lockfiles.
- Every PR body uses the required complexity, what, why, risk/test-focus, expected-result, and verification sections.
- The fixed six titles are milestone PRs. An emergent production defect gets a separately tracked atomic repair PR
  titled `🐛 [pi-omp-pr-monitor] fix: <description> [repair <n>]`; it does not renumber merged or unopened milestones.
  The blocked milestone resumes only after the repair merges and its focused checks pass.
- Once an implementation PR is opened, start its PR monitor immediately and follow the repository's monitor skill.

## Delivery Sequence

| Step | Exact PR title | Complexity | Soft line target |
|---|---|---|---:|
| 1/6 | `🌱 [pi-omp-pr-monitor] docs: plan Pi and OMP support [step 1/6]` | Trivial plan, skill copy, and regression baseline | 1,150 |
| 2/6 | `⚙️ [pi-omp-pr-monitor] refactor: centralize monitor session orchestration [step 2/6]` | Moderate shared-state and lifecycle refactor | 1,400 |
| 3/6 | `⚙️ [pi-omp-pr-monitor] build: split harness distribution workspaces [step 3/6]` | Moderate package/build/release migration | 1,200 |
| 4/6 | `🚧 [pi-omp-pr-monitor] feat(pi): add Pi and OMP monitoring [step 4/6]` | Complex host compatibility and background delivery | 1,500 |
| 5/6 | `🌱 [pi-omp-pr-monitor] docs: document cross-harness regression coverage [step 5/6]` | Trivial documentation reconciliation | 700 |
| 6/6 | `⚙️ [pi-omp-pr-monitor] test: verify Pi and OMP and retire the plan [step 6/6]` | Moderate packaged, live-host, and external verification | 700 |

## Step Details

### Step 1/6: Raise the plan and install planning skills

- Add this `PLAN.md` and `TRACKER.md` under `.plan/active/pi-omp-pr-monitor/`.
- Copy `sesori-plan-maker` and `sesori-plan-worker` unchanged into `.agents/skills/` so future planning and
  execution sessions discover the same workflow from this repository.
- Add `docs/regression/README.md` now because both planning skills require its proof levels and retirement rules;
  Step 5 completes the feature-specific catalog.
- Validate copied files byte-for-byte, fixed titles/totals, Markdown structure, and `git diff --check`.
- Do not run TypeScript or bundle suites for this documentation/skill-only step.

### Step 2/6: Centralize monitor session orchestration

- Add `runtime/monitor-session.ts`, `runtime/node-gh.ts`, and a small shared action/tool contract.
- Make `MonitorSession` the single owner of common session watch state and operations described above.
- Move the OpenCode shell runner to `opencode/gh.ts`; move the Node runner to `runtime/node-gh.ts`; remove all host
  imports from `core/`.
- Remove `sessionID` from `PrWatch` and keep session association solely in adapter/runtime registries.
- Split common and Claude-only configuration and add `.pr-monitor.json` as the first shared candidate while
  preserving existing locations.
- Adapt OpenCode and Claude Code to the runtime without changing their delivery, reload, handoff, keep-alive,
  shutdown, or config-fallback behavior.
- Add runtime contract tests for duplicate starts, per-session isolation, timer cleanup, config/auth resolution,
  actions, shutdown channel choice, identity-safe removal, and label-before-handoff behavior. A failed label call
  must keep Claude active; an idempotent success may hand off. Preserve and extend existing core/OpenCode tests.
- Centralize host-neutral tool wording: polling/delivery are automatic, and agents must never create delay jobs or
  polling loops. Preserve Claude's one narrow exception for the exact hook-issued event waiter.
- In the same PR, temporarily add `runtime/` to the root OpenCode package allowlist and make `pack:check` assert the
  packed source imports successfully. Step 3 replaces this transitional source package with the target bundle.
- Rebuild the committed Claude Code bundle.
- Verify with `npm test`, `npm run typecheck`, `npm run build`, `npm run pack:check`, source-focused tests, and
  `git diff --check`.

### Step 3/6: Split harness distribution workspaces

- Convert the root package to a private workspace coordinator.
- Move the existing OpenCode npm metadata into `opencode/package.json`; preserve package name, runtime dependency,
  engine floor, exports, and public metadata.
- Add publish-time ESM bundling for OpenCode, target README/license contents, tarball allowlisting, and an artifact
  import check for both `.` and `./server`.
- Add root scripts for all builds, tests, per-target pack inspection, version equality, and clean generated output.
- Keep Claude Code's marketplace root and committed plugin bundle arrangement intact.
- Add CI on supported Node platforms for tests, typecheck, build reproducibility, and OpenCode pack inspection.
- Update development/release instructions, but defer Pi installation documentation until Step 4 exists.
- Verify a locally packed OpenCode tarball in a disposable install and run the full existing test/build checks.

### Step 4/6: Add the Pi and OMP adapter

- Add the shared Pi-family implementation, upstream `pi/index.ts`, thin `pi/omp.ts`, package metadata, target
  README/license, and `pi/skills/monitor-pr/SKILL.md`.
- Register the complete `pr_monitor` action surface and delegate both entries to one session-owned
  `MonitorSession` implementation.
- Deliver normal, urgent, initial, terminal, and stop reports as visible `pr-monitor` custom messages with steering
  delivery and idle turn triggering.
- Start no timers during factory evaluation. Upstream Pi clears them on post-success `session_shutdown`; OMP clears
  them on post-success `session_switch` and process `session_shutdown`. Do not clear on cancelable before-events.
- Apply project trust and config-path rules, and expose the skill once in each host.
- Add Pi and OMP manifests, upstream host peer dependencies, bundle/pack scripts, lockstep version checks, and CI
  loader validation against Pi `0.84.2` and OMP `18.0.3` plus the then-current releases.
- Add fake-API contract tests for registration, every action, busy/idle delivery options, config trust,
  exactly-once skill discovery, autonomous-delivery wording, and delivery exceptions. Independently test successful
  new/resume/fork/reload/quit cleanup in both lifecycle models, canceled transitions, idempotence, and no old-session
  report delivery or duplicate timers after replacement.
- Make the Pi/OMP skill say to end the turn while idle: never use `sleep`, delayed Bash, cron, a background job,
  repeated `gh pr checks`, or routine `status`/`flush`. Require confirmed `mark_ready` success before handoff.
- Add packed-plugin loader smoke tests that require no model call, then disposable live tests with a configured model
  for direct wake-up behavior.
- Preserve OpenCode and Claude tests/build/pack checks in the same CI matrix.

### Step 5/6: Reconcile regression and product documentation

- Reconcile and complete `docs/regression/README.md` with final boundaries, matrix/result vocabulary, feature index,
  and plan-retirement rules.
- Add `docs/regression/pull-request-monitoring.md` for shared monitor semantics, confirmed ready-label handoff,
  autonomous notifications, the prohibition on agent-created waits/polling, and per-host delivery/lifecycle.
- Add `docs/regression/plugin-installation.md` for npm/Claude distributions, package contents, loader compatibility,
  and lockstep release metadata.
- Update root and target READMEs, `AGENTS.md`, and `CHANGELOG.md` with the final architecture, installation commands,
  config precedence, supported host floors, lifecycle limits, and Pi/OMP direct-delivery behavior.
- Reconcile any implementation deviation in this plan and tracker. Do not claim a host/platform row that has not
  actually run.
- Run Markdown/reference validation and `git diff --check`; no unchanged TypeScript suite is required for this
  documentation-only step.

### Step 6/6: Verify packaged hosts and retire the plan

- Run the complete regression matrix below against artifacts built from the final merged source.
- Record exact host/package versions, OS/runtime, privacy-safe evidence, failures, and cleanup in `TRACKER.md`.
- Confirm Steps 1-5 merged and every required row passed before moving
  `.plan/active/pi-omp-pr-monitor/` to `.plan/completed/pi-omp-pr-monitor/`.
- Keep the plan active on failure, blocked infrastructure, or an incomplete required host/platform matrix unless the
  user explicitly accepts and records a reduction here.
- This step contains verification evidence and retirement only. A discovered production defect keeps Step 6 open,
  receives the next `[repair <n>]` PR defined above, and triggers focused plus full-matrix reruns after merge. The
  fixed six milestone titles and total never change retroactively.

## Regression And Retirement Matrix

The highest required level is **L5 Full** because this work changes published package boundaries, depends on two
real host loaders, and ultimately delivers reports from an external GitHub service. The level is scoped to the PR
monitor; it does not require unrelated product checks.

| Area | Required evidence | Boundary and matrix |
|---|---|---|
| Core watch semantics | debounce, CI hold, instant failure/conflict/terminal delivery, baseline rollback, comment/thread identity, terminal stop | L2 automated; Node 22 on Linux, macOS, and Windows |
| Shared monitor session | action validation, duplicate-start race, session isolation, timer ownership, idempotent label success, label-failure-without-handoff, config/auth failures, normal/persistent shutdown channels | L3 automated adapter contract; all four adapters represented |
| OpenCode artifact | packed install, `.` and `./server` import, tool registration, initial delivery, model/agent preservation, session deletion, reload/shutdown notice | L3 actual OpenCode loader on Linux and macOS; automated Windows package import |
| Claude Code plugin | clean committed bundle, MCP tool start/status/stop/labels, spool injection, handoff/keep-alive, shutdown notice, no subagent drain | L3 automated MCP/hooks plus one live Claude Code session on a release host |
| Pi package | tarball install, exactly-once discovery, config/actions, anti-delay wording, busy/idle delivery, post-success shutdown/rebind and canceled-transition retention | L4 actual Pi minimum/current loaders; Linux/macOS, Windows loader smoke |
| OMP package | tarball install, import rewrite, exactly-once skill, same behavior, post-success switch cleanup, canceled-transition retention, no cross-session reports | L4 actual OMP minimum/current loaders; Linux/macOS, Windows loader smoke |
| Cross-host GitHub flow | one real open PR produces initial status, ordinary comment/review aggregation, failing-CI or conflict urgency where safely reproducible, ready-label handoff and withdrawal, and terminal stop | L5 packaged/external; authenticated `gh`, Pi and OMP live, representative OpenCode/Claude regression |
| Release contents | no private core package dependency, only declared files, host peers external, versions equal, Claude bundle reproducible, install docs match artifacts | L5 packaged; both npm tarballs plus Claude Git plugin root |

Privacy-safe evidence records only versions, target keys from a disposable fixture repository, outcome summaries,
and checksums. It does not commit tokens, model credentials, prompts, comment bodies, raw session transcripts, or
host configuration files.

## Risks And Mitigations

- **Shared-runtime regression:** OpenCode and Claude have mature lifecycle edge cases. Step 2 captures them in
  runtime/adapter tests, including Claude's proven label-before-handoff ordering, and keeps delivery policy outside
  the extraction.
- **OpenCode packaging change:** bundling replaces source execution in the npm artifact. Step 3 preserves the sole
  export and tests both supported entry points from the packed tarball before Pi work builds on it.
- **OMP compatibility drift:** keep its post-success `session_switch` adaptation in one thin entrypoint and test both
  a floor and current OMP release before publishing; all monitor behavior remains shared.
- **Extension replacement leaks:** test every successful and canceled transition in each host's real lifecycle model,
  and verify old callbacks cannot deliver into or remove successor-session watches.
- **Untrusted config:** Pi defaults rather than reading project files when trust is absent. No attempt is made to
  emulate a separate trust gate in OMP.
- **Package version skew:** root validation makes a release fail before pack/publish when OpenCode, Pi, and Claude
  metadata diverge.
- **Generated artifact drift:** OpenCode/Pi bundles are ephemeral and inspected during pack; Claude remains committed
  and checked for a clean rebuild because its installer performs no build.

## Plan Review Record

No architecture-plan-review was run for Step 1. This repository has no applicable repository-local architecture
review skill or instruction, and the referenced Apps Monorepo reviewer is specific to Dart/Flutter bridge/client
layers that do not exist here. The plan was instead checked directly against the current TypeScript dependency
flow, host lifecycle contracts, package-manager documentation, tests, and Git history. Future implementation review
should use a repository-appropriate reviewer if one is added before those steps begin.
