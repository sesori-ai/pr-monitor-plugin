# Pi And OMP PR Monitor Support: Tracker

## Current State

- **Plan slug:** `pi-omp-pr-monitor`
- **Plan status:** Step 1/6 open for review
- **Current branch:** `cross-harness-plugin-scaling`
- **Current PR:** [#10](https://github.com/sesori-ai/opencode-pr-monitor/pull/10)
- **Implementation started:** no
- **Next action:** pass review and merge Step 1; then start the shared-runtime Step 2
- **Retirement:** blocked until every required row in `PLAN.md` passes

## Fixed Delivery Sequence

| Done | Step | Exact PR title | Complexity | Soft line target | State |
|---|---|---|---|---:|---|
| [ ] | 1/6 | `🌱 [pi-omp-pr-monitor] docs: plan Pi and OMP support [step 1/6]` | Trivial plan, exact skill copy, and regression baseline | 1,150 | [PR #10](https://github.com/sesori-ai/opencode-pr-monitor/pull/10) open |
| [ ] | 2/6 | `⚙️ [pi-omp-pr-monitor] refactor: centralize monitor session orchestration [step 2/6]` | Moderate shared-state and lifecycle refactor | 1,400 | Pending Step 1 |
| [ ] | 3/6 | `⚙️ [pi-omp-pr-monitor] build: split harness distribution workspaces [step 3/6]` | Moderate package/build/release migration | 1,200 | Pending Step 2 |
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

## Review Log

| Date | Review | Result |
|---|---|---|
| 2026-08-23 | Architecture plan review applicability | Not run: this repository has no applicable reviewer; the available source reviewer is specific to another repository's Dart/Flutter architecture. See `PLAN.md`. |
| 2026-08-23 | Cubic: missing regression path in worker | Declined after clarification: only old plans without a matrix consult it at retirement; this plan creates it before retirement. The later Codex comment exposed the broader plan-maker dependency, so the baseline is now included in Step 1 anyway. |
| 2026-08-23 | Codex: session replacement cleanup | Accepted with correction: upstream Pi emits shutdown only after successful replacement, while OMP emits post-success switch. The plan now uses separate thin entries and never clears on cancelable before-events. |
| 2026-08-23 | Codex: regression guidance unavailable | Accepted: `docs/regression/README.md` now ships with the planning skills; Step 5 reconciles/completes it. |
| 2026-08-23 | Codex: impossible late renumbering | Accepted: emergent defects use numbered repair PRs outside the fixed six milestones, followed by focused and full reruns. |

## Verification Log

### Step 1/6

- [x] Both copied skill files are byte-identical to their requested sources.
- [x] Plan validation passes: fixed slug, six exact ordered titles, and balanced Markdown fences.
- [x] Regression baseline defines cumulative L1-L5 levels, proof boundaries, result states, evidence privacy, feature
  maintenance, and plan-retirement rules required by the copied skills.
- [x] Every referenced current source path exists; future paths are explicitly assigned to implementation steps.
- [x] `git diff --check` passes.
- [x] Changed lines: 1,059, within the revised 1,150-line Step 1 target.
- [x] TypeScript, host, and bundle suites not run: this step changes only plans and agent skills.
- [x] Commit `17b1562` pushed and [PR #10](https://github.com/sesori-ai/opencode-pr-monitor/pull/10) opened with the exact Step 1 title.
- [x] User clarification incorporated: preserve reliable Claude ready-label handoff, discover the Pi/OMP skill once,
  and make autonomous notification/no-agent-delay behavior an explicit tested contract.
- [x] PR review incorporated: available regression baseline, correct Pi-versus-OMP replacement lifecycles, canceled
  transition retention, and a non-renumbering repair flow.

Later steps append focused verification here. Do not mark a regression row passed without the boundary and host/
platform matrix required by `PLAN.md`.
