---
description: Turn auto-merge on or off for an active PR monitor
argument-hint: "on|off [owner/repo#123 | PR URL]"
---

Change auto-merge for a running monitor with the pr_monitor tool (action "set_auto_merge", `autoMerge: true` for
on, `autoMerge: false` for off).

Arguments: $ARGUMENTS

If neither on nor off was given, ask which one I want. If no PR was given, resolve the current branch's open PR with
`gh pr view --json url -q .url`. The pr argument passed to the tool must be explicit — `owner/repo#123` or a full
PR URL. If no monitor is active for it: for on, start one with the pr_monitor tool (action "start") and
`autoMerge: true` instead; for off, report that no monitor is active and change nothing.

Briefly confirm the exact tool result. Turning it on for a PR that already carries the ready label removes that
label; reassess the current head and call `mark_ready` once checks have settled, CI is green, the PR is mergeable,
and nothing actionable remains. With auto-merge on, `mark_ready` makes one squash-merge attempt, which is what I
asked for: do not hold it back to wait for human review. Inspect its result; after `Auto-merge succeeded` or a
rejected or unknown outcome, never repeat `mark_ready` unless the PR changed and a new attempt is warranted.
