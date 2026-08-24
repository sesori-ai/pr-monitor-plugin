# PR Monitor Regression Testing

This directory is the durable source of truth for agent-run regression testing in this repository. Feature files
state fixed behavior and required boundaries while allowing the executor to vary fixtures, order, and tools.
Production code and released host behavior remain authoritative when documentation drifts.

## Levels

| Level | Name | Required confidence |
|---|---|---|
| L1 | Smoke | Critical modules load and the shortest product heartbeat works. |
| L2 | Routine | Important normal and deterministic failure behavior passes at its owning boundary. |
| L3 | Release | Critical user journeys pass through every changed production adapter or artifact. |
| L4 | Extended | Lifecycle, concurrency, recovery, compatibility, and required platform variants pass. |
| L5 | Full | The complete documented matrix passes, including packaged artifacts and external services. |

Levels are cumulative. A requested L4 run includes all applicable L1-L4 requirements. A feature may begin at any
level. A higher-boundary check may satisfy a lower-boundary invariant once when it proves the complete same claim.
Missing infrastructure is `Blocked`, not inapplicable, when the plan or feature document requires that boundary.

## Proof Boundaries

Use the shortest boundary that observes the complete invariant:

| Boundary | Appropriate use |
|---|---|
| Automated | Pure state, parsing, report rendering, deterministic timing, and error rollback. |
| Adapter contract | Host API registration, delivery options, session ownership, and lifecycle using controlled fakes. |
| Actual host | A real OpenCode, Claude Code, Pi, or OMP loader/session must interpret or deliver the behavior. |
| Packaged or external | npm/Git installation, release contents, GitHub, or another production service is part of the claim. |

A source import does not prove a packed artifact. A fake host does not prove actual loader compatibility. One host
or platform proves only that matrix row unless the owning feature document explicitly names it representative.

## Running And Recording Coverage

1. Collect every applicable requirement through the requested level from each affected feature document.
2. Preserve every named host, package, platform, runtime, lifecycle, and external-service matrix row.
3. Run focused lower-boundary checks before expensive actual-host or external checks.
4. Record `Pass`, `Partial`, `Fail`, `Blocked`, or `Not run`, including versions, boundary, matrix, variations,
   first divergent boundary, linked defects, and cleanup.
5. Keep only privacy-safe evidence. Never commit credentials, prompts, transcripts, comment bodies, raw logs,
   account identifiers, tokens, or local host configuration.

`Partial` means some executed scope passed but required matrix rows did not run. `Blocked` means required
infrastructure prevented an attempted row. `Not run` means no required row was attempted and therefore no pass/fail
evidence exists. None is a pass. Clean up test PRs, labels, package installs, timers, sessions, and temporary
configuration unless retained residue is explicitly recorded for diagnosis.

## Feature Maintenance

Add or update a feature file when product behavior, delivery, lifecycle, package contents, compatibility, or a known
limitation changes. Keep acceptance criteria fixed but avoid brittle click-by-click scripts. Feature files should
name the owning source/tests, highest level, proof boundary, and required host/platform matrix.

The planned initial feature documents are:

- `pull-request-monitoring.md` for shared watch semantics and host delivery/lifecycle;
- `plugin-installation.md` for npm and Claude Code artifacts, loaders, and release metadata.

They are created and reconciled in the penultimate documentation step of the active Pi/OMP plan.

## Durable Plan Retirement

A durable plan records its highest required level and complete matrix before implementation. Its final step runs
that exact coverage against the final merged source and records results in the tracker. Move a plan from
`.plan/active/` to `.plan/completed/` only after all required rows pass.

A reduction requires explicit user acceptance recorded in `PLAN.md`. `Partial`, `Blocked`, `Fail`, or `Not run`
required coverage keeps the plan active. If verification finds a production defect, merge a separately tracked
repair PR, rerun the affected checks plus the full retirement matrix, and retire only after both pass.
