# Pi And OMP PR Monitor Support: Tracker

## Current State

- **Plan slug:** `pi-omp-pr-monitor`
- **Plan status:** Step 2/6 open; Step 3/6 complete on an unpublished local successor
- **Current branch:** `pi-omp-pr-monitor-step-3`
- **Current PR:** Step 2 [#11](https://github.com/sesori-ai/opencode-pr-monitor/pull/11)
- **Implementation started:** yes
- **Next action:** address Step 2 review/monitor reports; after merge, rebase and publish the completed Step 3
- **Retirement:** blocked until every required row in `PLAN.md` passes

## Fixed Delivery Sequence

| Done | Step | Exact PR title | Complexity | Soft line target | State |
|---|---|---|---|---:|---|
| [x] | 1/6 | `🌱 [pi-omp-pr-monitor] docs: plan Pi and OMP support [step 1/6]` | Trivial plan, exact skill copy, and regression baseline | 1,150 | [PR #10](https://github.com/sesori-ai/opencode-pr-monitor/pull/10) merged |
| [ ] | 2/6 | `🚧 [pi-omp-pr-monitor] refactor: centralize monitor session orchestration [step 2/6]` | Complex shared concurrency/lifecycle boundary refactor | 2,100 | [PR #11](https://github.com/sesori-ai/opencode-pr-monitor/pull/11) open |
| [ ] | 3/6 | `⚙️ [pi-omp-pr-monitor] build: split harness distribution workspaces [step 3/6]` | Moderate package/build/release migration | 1,200 | Complete locally on `pi-omp-pr-monitor-step-3`; unpublished pending Step 2 |
| [ ] | 4/6 | `🚧 [pi-omp-pr-monitor] feat(pi): add Pi and OMP monitoring [step 4/6]` | Complex host compatibility and background delivery | 1,500 | Pending Step 3 |
| [ ] | 5/6 | `🌱 [pi-omp-pr-monitor] docs: document cross-harness regression coverage [step 5/6]` | Trivial documentation reconciliation | 700 | Pending Step 4 |
| [ ] | 6/6 | `⚙️ [pi-omp-pr-monitor] test: verify Pi and OMP and retire the plan [step 6/6]` | Moderate packaged, live-host, and external verification | 700 | Pending Step 5 |

The six milestone titles and total are fixed. Emergent defects use separately tracked
`🐛 [pi-omp-pr-monitor] fix: <description> [repair <n>]` PRs without renumbering milestones; the blocked milestone
resumes only after its repair passes. Do not silently exceed the 1,500-line soft cap.

## Locked Decisions

- Keep one Git repository with private shared source and separate host artifacts.
- Add one shared Pi-family implementation/package for Pi and OMP; no OMP monitor fork or npm alias.
- Use a thin OMP entrypoint only for its post-success `session_switch` lifecycle/resource seam; upstream Pi uses
  post-success `session_shutdown` and a fresh extension instance. Never clear on cancelable before-events.
- Use native Pi `sendMessage` delivery, not Claude's MCP/spool path.
- Extract one session-level runtime used by OpenCode, Claude, and Pi/OMP while keeping host delivery/lifecycle policy
  in adapters.
- Bundle private core/runtime into npm artifacts rather than publishing a core package.
- Make the root package private; publish OpenCode and Pi from target workspaces.
- Preserve Claude's plugin-root, hook, spool, keep-alive, committed-bundle design, and label-before-handoff ordering.
- A failed `mark_ready` never records handoff or releases Claude keep-alive; skills must not claim success and must
  diagnose/retry. Idempotent label success is valid handoff.
- Every tool description and shipped monitor skill says reports arrive automatically and agents must never invent
  sleeps, delayed/scheduled jobs, polling loops, repeated `gh pr checks`, or routine `status`/`flush` while waiting.
- Claude's sole waiting exception is the exact `await-activity.mjs` event waiter issued by its keep-alive hook.
  Pi/OMP end the turn and rely on native `sendMessage` wake-up.
- Pi and OMP discover the same package skill exactly once.
- Keep one release version across both npm artifacts and Claude metadata.
- Keep watches in-memory and session-scoped; no daemon or persistent restoration.
- Add `.pr-monitor.json` as the common config location while retaining existing host config fallbacks.

## Step 1 Checklist

- [x] Read the requested `sesori-plan-maker` skill completely.
- [x] Inspect the related `sesori-plan-worker` skill and current repository instructions.
- [x] Inspect current core, OpenCode, Claude Code, tests, package/release metadata, and relevant Git history.
- [x] Verify current Pi and OMP extension/package APIs and compatibility behavior.
- [x] Define the single-repository architecture, mutable-state budget, cleanup, six-step sequence, and retirement
  matrix.
- [x] Copy `sesori-plan-maker` and `sesori-plan-worker` under `.agents/skills/`.
- [x] Verify both copied skill files are byte-identical to their requested sources.
- [x] Add the regression-level/proof-boundary baseline required by those skills.
- [x] Write `PLAN.md` and this tracker under `.plan/active/pi-omp-pr-monitor/`.
- [x] Validate fixed titles/totals, Markdown paths, changed-line count, and `git diff --check`.
- [x] Commit with the exact Step 1 title, push, and open the planning PR with the required body sections.

## Step 2 Checklist

- [x] Sync from merged Step 1 and create `pi-omp-pr-monitor-step-2` in the existing worktree.
- [x] Remove host SDK imports and runner construction from `core/`; remove `PrWatch.sessionID`.
- [x] Split common and Claude-only config and add repository `.pr-monitor.json` precedence.
- [x] Add `MonitorSession`, shared Node runner, action enum, and autonomous-delivery/no-delay wording.
- [x] Adapt OpenCode and Claude Code while preserving delivery, reload, handoff, keep-alive, and shutdown channels.
- [x] Keep label success before Claude handoff and retain keep-alive after label failure.
- [x] Add `runtime/` to the transitional npm allowlist and validate the packed OpenCode import graph.
- [x] Add shared-runtime/config/lifecycle/label tests and update the Claude `monitor-pr` skill.
- [x] Rebuild the committed Claude Code bundle and update current architecture/config documentation.
- [x] Complete final tests, direct source review, dependency/line-width checks, and diff/line-count checks.
- [x] Commit `a1d0e2e`, push, and open [PR #11](https://github.com/sesori-ai/opencode-pr-monitor/pull/11).

The Step 2 diff is expected near 2,100 changed lines and is intentionally above the 1,500-line soft cap. The runtime,
both shipping adapters, transitional package allowlist, and tests form one atomic ownership migration; splitting an
adapter or package would leave a merged revision duplicated or unpublishable. Complexity is reassessed from ⚙️ to 🚧
because the implementation moves concurrency and lifecycle ownership.

## Step 3 Checklist

- [x] Convert the root to private workspace coordinator version `0.0.0`.
- [x] Move OpenCode product metadata/dependency/version into `opencode/package.json`.
- [x] Bundle private core/runtime into ephemeral ESM while externalizing `@opencode-ai/plugin`.
- [x] Preserve `.` and `./server`, add target README/license, and enforce exact tarball contents.
- [x] Install the packed artifact in a temporary consumer and import both exports with sole `PrMonitorPlugin`.
- [x] Add clean/build/version/release scripts and verify OpenCode/Claude/lock/MCP versions agree.
- [x] Preserve the committed Claude plugin root/bundle and add Linux/macOS/Windows Node 22 CI.
- [x] Update development/release/architecture docs and regenerate the workspace lockfile.
- [x] Complete a clean `npm ci`, release checks, prepack check, actionlint, line-width, and diff checks.
- [ ] Keep local until Step 2 merges; then rebase onto `main`, commit/push, and open Step 3.

## Review Log

| Date | Review | Result |
|---|---|---|
| 2026-08-23 | Architecture plan review applicability | Not run: this repository has no applicable reviewer; the available source reviewer is specific to another repository's Dart/Flutter architecture. See `PLAN.md`. |
| 2026-08-23 | Cubic: missing regression path in worker | Declined after clarification: only old plans without a matrix consult it at retirement; this plan creates it before retirement. The later Codex comment exposed the broader plan-maker dependency, so the baseline is now included in Step 1 anyway. |
| 2026-08-23 | Codex: session replacement cleanup | Accepted with correction: upstream Pi emits shutdown only after successful replacement, while OMP emits post-success switch. The plan now uses separate thin entries and never clears on cancelable before-events. |
| 2026-08-23 | Codex: regression guidance unavailable | Accepted: `docs/regression/README.md` now ships with the planning skills; Step 5 reconciles/completes it. |
| 2026-08-23 | Codex: impossible late renumbering | Accepted: emergent defects use numbered repair PRs outside the fixed six milestones, followed by focused and full reruns. |
| 2026-08-24 | Codex: Step 2 package omits runtime | Accepted: Step 2 now adds `runtime/` to the root allowlist and proves the packed import; Step 3 replaces it with bundled workspaces. |
| 2026-08-24 | Cubic: undefined `Not run` result | Accepted: the regression baseline now distinguishes no attempted row from partial execution and makes every non-pass state block retirement. |
| 2026-08-24 | Step 2 implementation review applicability | No repository-local `architecture-implementation-review` skill is available; perform direct source/diff review plus the planned automated/build/pack checks. |
| 2026-08-24 | Cubic: bundle rebuild trigger | Accepted: AGENTS and `.gitattributes` now name runtime alongside core/Claude source. |
| 2026-08-24 | Cubic: pack graph portability/completeness | Accepted: normalize Windows separators and include side-effect imports in graph traversal. |
| 2026-08-24 | Cubic: case-variant targets | Accepted: registry keys normalize owner/repo casing while reports retain caller casing; duplicate/start/stop test added. |
| 2026-08-24 | Cubic: in-flight start after cleanup | Accepted: lifecycle generation invalidates starts crossing `stopAll`; dedicated timer/map test added. |
| 2026-08-24 | Cubic: unconditional CI/label wording | Accepted: tool text names `flushOnCiFailure` and the configured ready label; assertions added. |
| 2026-08-24 | Cubic/Codex: case-variant Claude handoff | Accepted: ready events use the watched target identity and Claude stores normalized registry keys; the handoff test marks and unmarks through variant casing. |

## Verification Log

### Step 1/6

- [x] Both copied skill files are byte-identical to their requested sources.
- [x] Plan validation passes: fixed slug, six exact ordered titles, and balanced Markdown fences.
- [x] Regression baseline defines cumulative L1-L5 levels, proof boundaries, result states, evidence privacy, feature
  maintenance, and plan-retirement rules required by the copied skills.
- [x] Every referenced current source path exists; future paths are explicitly assigned to implementation steps.
- [x] `git diff --check` passes.
- [x] Changed lines: 1,065, within the revised 1,150-line Step 1 target.
- [x] TypeScript, host, and bundle suites not run: this step changes only plans and agent skills.
- [x] Commit `17b1562` pushed and [PR #10](https://github.com/sesori-ai/opencode-pr-monitor/pull/10) opened with the exact Step 1 title.
- [x] User clarification incorporated: preserve reliable Claude ready-label handoff, discover the Pi/OMP skill once,
  and make autonomous notification/no-agent-delay behavior an explicit tested contract.
- [x] PR review incorporated: available regression baseline, correct Pi-versus-OMP replacement lifecycles, canceled
  transition retention, a non-renumbering repair flow, independently packable Step 2, and complete result states.

### Step 2/6

- [x] `npm test` — 24 tests pass, including lifecycle cleanup and case-insensitive registry and ready-handoff behavior.
- [x] `npm run typecheck`.
- [x] `npm run pack:check` — packed OpenCode graph includes all 11 reachable local imports.
- [x] `npm run build` — Claude Code bundle rebuilt twice with SHA-256
  `df5c43e28a05cbe0baeb445b9c725ec878aa7bd0591047cbcfa571581ac718d4` both times.
- [x] Packed OpenCode entry imports with sole export `PrMonitorPlugin`; Claude bundle starts and shuts down over stdio.
- [x] Core/runtime host-import scans, rewritten-source 120-column check, and `git diff --check` pass.
- [x] Diff: 2,028 textual changed lines including review fixes, within the recorded 2,100-line target.

### Step 3/6 (local successor)

- [x] Clean `npm ci`; `npm test` (24/24); `npm run typecheck`; `npm run build`.
- [x] `npm run version:check` — OpenCode, Claude manifest, lockfile, and MCP source all `0.2.1`.
- [x] `npm run pack:check` — exact four-file tarball; temporary install; `.`/`./server` sole-export imports.
- [x] `npm run release:check`; workspace prepack rebuild; OpenCode clean/build cycle.
- [x] Claude committed bundle unchanged; root/target licenses byte-identical; `actionlint` and `git diff --check` pass.
- [x] Local diff: 470 textual changed lines, within the 1,200-line target.

Later steps append focused verification here. Do not mark a regression row passed without the boundary and host/
platform matrix required by `PLAN.md`.
