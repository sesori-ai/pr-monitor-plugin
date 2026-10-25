---
description: Withdraw the ready label from a GitHub PR
argument-hint: "[owner/repo#123 | PR URL]"
---

Withdraw the ready label with the pr_monitor tool (action "unmark_ready"). This removes the
configured ready label (default `agent-ready`, config key `readyLabel`) now. It does not create a
permanent hold: an active monitor may restore readiness after a later clean assessment.

PR to unmark: $ARGUMENTS

If no PR was given above, resolve the current branch's open PR with `gh pr view --json url -q .url` and unmark that one. The pr argument passed to the tool must be explicit — `owner/repo#123` or a full PR URL.

New feedback normally causes the monitor to remove readiness automatically. Use this command only for an explicit
immediate withdrawal; then follow the monitor-pr skill and its readiness line.
