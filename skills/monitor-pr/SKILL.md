---
name: monitor-pr
description: >-
  Drive a GitHub PR to ready-for-human-review without supervision. Start
  pr_monitor immediately after opening a PR and act on every automatic report;
  the monitor owns polling and readiness labels, so never create sleeps,
  scheduled checks, or polling loops. Address new feedback on every changed
  thread, failing CI, and conflicts. Use after raising a PR, when asked to watch
  one, and whenever a "[PR Monitor]" message appears.
---

# monitor-pr

Own a PR from creation through handoff. The monitor polls GitHub, delivers
reports, and automatically adds or withdraws the configured ready label. The
agent owns the substantive judgment: inspect every new comment, fix what is
valid, and use `mark_ready` when new activity is non-actionable and deliberately
needs no GitHub reply.

## 1. Start monitoring immediately

Right after raising a PR:

```
pr_monitor(action: "start", pr: "owner/repo#123")
```

- Always pass an explicit PR; never infer it from the working directory.
- Start one monitor per PR. In a fresh session, use `status` once and restart a
  missing watch.
- The start result states the configured agent-reply prefix. Every GitHub reply
  authored by the agent **must begin with that exact prefix** (default
  `<!-- pr-monitor:reply -->`). A comment from the local GitHub account without
  the prefix is human feedback, not an agent reply.

## 2. Handle every report

Address everything in one batch:

- **CI failing, including a failure while CI is running:** inspect the named
  checks, fix the root cause, test, commit, and push. Never delete or weaken a
  test to make CI green.
- **Mergeable: CONFLICTING:** fetch the actual base and merge it into the PR
  branch. Never rebase or force-push. Resolve conservatively, test, and push.
- **`ACTION REQUIRED` inline feedback:** inspect every thread that received a
  new relevant comment. The unresolved-thread count may be unchanged, and the
  thread may already be resolved. Neither fact means the follow-up was handled.
- **New review summaries or issue comments:** fetch their bodies and assess
  them. Reports intentionally contain authors/counts, not comment bodies.
- **A local-account, unprefixed comment:** treat it as a human instruction even
  though the agent uses the same GitHub account.
- **Merged/closed:** monitoring stopped; no further action.

When taking action, reply on GitHub with the configured prefix first. It is the
monitor's authoritative evidence that the latest feedback on that channel was
handled. Threads may remain unresolved intentionally for a human reviewer; a
prefixed final reply is what matters for automatic readiness.

A delivered report already advances its "new since last flush" baseline. Never
call `flush` routinely after handling it.

## 3. Respect the readiness line

Every report states one of:

- `Ready for human review: YES` — the GitHub label is present. Do not remove it
  merely because a thread was resolved, an approval arrived, or another
  readiness-preserving report was delivered.
- `Ready for human review: NO` — keep working until the report's blockers are
  handled, or manually accept the current state when judgment says no action is
  required.

Automatic readiness requires green/no CI, definite mergeability, and a
prefixed local reply after the latest feedback in every threaded or flat
feedback channel. It deliberately ignores unresolved-thread count, stale
`CHANGES_REQUESTED`, pending reviewers, and draft state.

A new commit, relevant comment/review summary, CI regression, or definite
conflict withdraws readiness. Thread resolution alone does not.

## 4. Handle non-actionable bot acknowledgements without a loop

A bot may post an acknowledgement after a fix. That new activity correctly
withdraws readiness, but replying merely to acknowledge the acknowledgement can
create an endless bot loop.

1. Fetch and inspect the comment.
2. If it asks for work, do the work and leave a prefixed reply.
3. If it is non-actionable, **do not reply**. Manually accept the current state:

```
pr_monitor(action: "mark_ready", pr: "owner/repo#123")
```

`mark_ready` is an unconditional judgment override. It accepts all activity
currently observed by the watch and adds the label. Only later invalidating
activity withdraws it again. Claim handoff only after the tool confirms success.

`unmark_ready` removes the label now, but it is not a permanent hold; automatic
readiness may restore it after a later clean assessment.

## 5. Never invent a wait

The monitor owns polling and notifications. Never create sleeps, delayed jobs,
cron, background polling loops, repeated `gh pr checks`, or routine
`status`/`flush` calls. When there is no delivered report to handle, end the
turn and rely on host-native delivery.

## Avoid the bot-review spiral

Every push can trigger another review wave. A bot edge case earns a code change
only when it is plausible and consequential. Decline contrived findings with a
prefixed reasoned reply. If several rounds cluster on one seam, fix the seam
once or surface the concern rather than accumulating patches.
