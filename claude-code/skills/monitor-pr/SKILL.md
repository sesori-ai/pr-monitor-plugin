---
name: monitor-pr
description: >-
  Drive a GitHub PR to ready-for-human-review without supervision. Start
  pr_monitor immediately after opening a PR and act on every automatic report;
  the monitor owns polling and readiness labels, so never create sleeps,
  scheduled checks, or polling loops. Address every newly commented thread,
  failing CI, and conflicts. Use after `gh pr create`, when asked to watch a PR,
  and whenever a "[PR Monitor]" or "[PR Monitor keep-alive]" message appears.
---

# monitor-pr

Own a PR from creation through handoff. The monitor polls GitHub, delivers
reports, and automatically adds or withdraws the configured ready label. The
agent judges the substance of feedback and may manually accept non-actionable
activity without creating bot acknowledgement loops.

## 1. Start immediately

After `gh pr create`:

```
pr_monitor(action: "start", pr: "owner/repo#123")
```

Always pass an explicit PR. Watches belong to this Claude process and do not
survive a restart. In a fresh session, use `status` once and restart anything
missing.

The start result states the configured agent-reply prefix. Every GitHub reply
written by the agent **must begin with that exact prefix** (default
`<!-- pr-monitor:reply -->`). The human owner may comment through the same
GitHub account; an unprefixed local-account comment is therefore human feedback.

## 2. Handle every report

- For failing CI, inspect the named check, fix the root cause, test, commit, and
  push. Never weaken tests.
- For `Mergeable: CONFLICTING`, merge the actual base into the PR branch. Never
  rebase or force-push; preserve both sides and test.
- For `ACTION REQUIRED` inline feedback, inspect **every thread that received a
  new relevant comment**, including existing unresolved and resolved threads.
  An unchanged unresolved-thread count does not mean there is no new feedback.
- Fetch bodies for new review summaries and issue comments; reports omit them.
- Treat a local-account, unprefixed comment as a human instruction.
- A merged/closed report is terminal; the monitor stopped itself.

When feedback needs a response, begin the GitHub reply with the configured
prefix. That final prefixed reply—not thread resolution—is the monitor's
authoritative evidence that the feedback channel was handled. Deliberately
unresolved threads are allowed for human review.

A delivered report already advanced its baseline. Never routinely call `flush`
after handling one.

## 3. Follow readiness, do not reconstruct it

Every report explicitly says `Ready for human review: YES` or `NO`.

- `YES`: the label is present and Claude keep-alive is handed off. A
  resolution-only or approval report must not cause `unmark_ready`.
- `NO`: keep working, or use manual `mark_ready` when inspection shows nothing
  actionable remains.

Automatic readiness requires passing/no CI, definite mergeability, and a
prefixed local reply after the latest threaded and flat feedback. It ignores
unresolved-thread count, stale `CHANGES_REQUESTED`, pending reviewers, and draft
state. A new commit, relevant comment/review summary, CI regression, or definite
conflict withdraws readiness. Thread resolution alone does not.

## 4. Do not acknowledge an acknowledgement

A bot may post a non-actionable acknowledgement after a fix. Its new comment
correctly withdraws readiness. Inspect it, but do **not** reply merely to make
the bot acknowledge another acknowledgement. Instead call:

```
pr_monitor(action: "mark_ready", pr: "owner/repo#123")
```

`mark_ready` unconditionally accepts all activity currently observed by the
watch and adds the label. Only later invalidating activity withdraws it. Claim
handoff only after the tool confirms success.

If the comment asks for work, do that work and leave a prefixed reply instead.
`unmark_ready` removes the label now but does not create a permanent hold;
automation may restore readiness after a later clean assessment.

## 5. Never invent a wait

Never run `sleep`, delayed Bash, cron, a background polling loop, repeated
`gh pr checks`, or routine `status`/`flush` calls. The monitor owns polling.

When a turn would end while a PR is not ready, the plugin may inject a
`[PR Monitor keep-alive]` message containing the exact waiter:

```
node "<plugin>/hooks/await-activity.mjs" --session <pid> --timeout 540
```

That hook-issued command is the only permitted waiter. Run it only when asked,
using Bash with `timeout: 600000`. Never wrap it in another delay. If no
keep-alive message asks, end the turn. If the user asks to stop, call
`pr_monitor(action: "stop", pr: "all")`.

## Other actions

- `status`: list this session's watches and handoff state.
- `flush`: deliberately fetch a full status; never routine after a report.
- `stop`: stop one/all watches without waiting for merge.

## Avoid the bot-review spiral

A bot edge case earns a code change only when plausible and consequential.
Decline contrived findings with one prefixed reasoned reply. If feedback rounds
cluster on one seam, fix the seam once or surface it instead of accumulating
patches.
