---
description: Withdraw the ready-for-human-review label from a GitHub PR
argument-hint: "[owner/repo#123 | PR URL]"
---

Withdraw the ready-for-human-review label with the pr_monitor tool (action "unmark_ready"). This removes the configured ready label (default `ready-for-human-review`, config key `readyLabel`) from the PR on GitHub, so it stops advertising itself as awaiting a human while there is still work to do on it.

PR to unmark: $ARGUMENTS

If no PR was given above, resolve the current branch's open PR with `gh pr view --json url -q .url` and unmark that one. The pr argument passed to the tool must be explicit — `owner/repo#123` or a full PR URL.

Use this when new feedback arrives on a PR that was already marked ready, before working on it again. Afterwards, address the feedback and mark it ready again once it is clean — see the monitor-pr skill.
