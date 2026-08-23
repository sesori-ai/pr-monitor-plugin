# Pi And OMP PR Monitor Support: Tracker

## Current State

- **Plan slug:** `pi-omp-pr-monitor`
- **Plan status:** Step 1/6 in progress
- **Current branch:** `cross-harness-plugin-scaling`
- **Current PR:** not opened yet
- **Implementation started:** no
- **Next action:** validate, commit, push, and open the Step 1 planning/skills PR
- **Retirement:** blocked until every required row in `PLAN.md` passes

## Fixed Delivery Sequence

| Done | Step | Exact PR title | Complexity | Soft line target | State |
|---|---|---|---|---:|---|
| [ ] | 1/6 | `🌱 [pi-omp-pr-monitor] docs: plan Pi and OMP support [step 1/6]` | Trivial plan and exact skill copy | 1,000 | In progress |
| [ ] | 2/6 | `⚙️ [pi-omp-pr-monitor] refactor: centralize monitor session orchestration [step 2/6]` | Moderate shared-state and lifecycle refactor | 1,400 | Pending Step 1 |
| [ ] | 3/6 | `⚙️ [pi-omp-pr-monitor] build: split harness distribution workspaces [step 3/6]` | Moderate package/build/release migration | 1,200 | Pending Step 2 |
| [ ] | 4/6 | `🚧 [pi-omp-pr-monitor] feat(pi): add Pi and OMP monitoring [step 4/6]` | Complex host compatibility and background delivery | 1,500 | Pending Step 3 |
| [ ] | 5/6 | `🌱 [pi-omp-pr-monitor] docs: document cross-harness regression coverage [step 5/6]` | Trivial documentation reconciliation | 700 | Pending Step 4 |
| [ ] | 6/6 | `⚙️ [pi-omp-pr-monitor] test: verify Pi and OMP and retire the plan [step 6/6]` | Moderate packaged, live-host, and external verification | 700 | Pending Step 5 |

The total, order, complexity emoji, slug, and titles are fixed. If implementation evidence requires another
independently valid PR, update this plan and every unopened title before opening that PR. Do not silently exceed the
1,500-line soft cap.

## Locked Decisions

- Keep one Git repository with private shared source and separate host artifacts.
- Add one upstream-Pi-compatible extension/package for both Pi and OMP; no `omp/` source fork or npm alias.
- Use native Pi `sendMessage` delivery, not Claude's MCP/spool path.
- Extract one session-level runtime used by OpenCode, Claude, and Pi/OMP while keeping host delivery/lifecycle policy
  in adapters.
- Bundle private core/runtime into npm artifacts rather than publishing a core package.
- Make the root package private; publish OpenCode and Pi from target workspaces.
- Preserve Claude's plugin-root, hook, spool, keep-alive, and committed-bundle design.
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
- [x] Write `PLAN.md` and this tracker under `.plan/active/pi-omp-pr-monitor/`.
- [x] Validate fixed titles/totals, Markdown paths, changed-line count, and `git diff --check`.
- [ ] Commit with the exact Step 1 title, push, and open the planning PR with the required body sections.

## Review Log

| Date | Review | Result |
|---|---|---|
| 2026-08-23 | Architecture plan review applicability | Not run: this repository has no applicable reviewer; the available source reviewer is specific to another repository's Dart/Flutter architecture. See `PLAN.md`. |

## Verification Log

### Step 1/6

- [x] Both copied skill files are byte-identical to their requested sources.
- [x] Plan validation passes: fixed slug, six exact ordered titles, and balanced Markdown fences.
- [x] Every referenced current source path exists; future paths are explicitly assigned to implementation steps.
- [x] `git diff --check` passes.
- [x] Changed lines: 937, within the 1,000-line Step 1 target.
- [x] TypeScript, host, and bundle suites not run: this step changes only plans and agent skills.

Later steps append focused verification here. Do not mark a regression row passed without the boundary and host/
platform matrix required by `PLAN.md`.
