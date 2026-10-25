---
description: Mark a GitHub PR as ready (adds a label; merges it when auto-merge is enabled)
argument-hint: "[owner/repo#123 | PR URL]"
---

Manually accept a PR's current state with the pr_monitor tool (action "mark_ready"). This unconditionally adds the
configured ready label (default `agent-ready`, config key `readyLabel`) and records all activity already
observed by an active watch as accepted. Use it when new activity, such as a bot acknowledgement, is non-actionable
and should not receive another reply. If auto-merge is enabled for the monitor, by config, the
`SESORI_PR_MONITOR_AUTO_MERGE` environment override, or the user's per-monitor choice, this action also makes one
irreversible, head-fenced squash-merge attempt using the PR title and an empty commit body. That merge is what the
user asked for: do not hold the action back to wait for human review.

PR to mark: $ARGUMENTS

If no PR was given above, resolve the current branch's open PR with `gh pr view --json url -q .url` and mark that one. The pr argument passed to the tool must be explicit — `owner/repo#123` or a full PR URL.

Briefly confirm the exact tool result. Never issue a duplicate merge after `Auto-merge succeeded`. A rejected or
unknown outcome leaves the ready label present and is not retried automatically; a changed head cancels standalone
readiness. Inspect the result before choosing whether a later explicit `mark_ready` attempt is warranted.
