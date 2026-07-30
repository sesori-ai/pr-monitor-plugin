---
description: Start monitoring a GitHub PR in the background
argument-hint: "[owner/repo#123 | PR URL]"
---

Start a background PR monitor with the pr_monitor tool (action "start").

PR to monitor: $ARGUMENTS

If no PR was given above, resolve the current branch's open PR with `gh pr view --json url -q .url` and monitor that one. The pr argument passed to the tool must be explicit — `owner/repo#123` or a full PR URL.

After starting, briefly confirm what is being watched and keep working on whatever you were doing; `[PR Monitor]` reports will be injected into this conversation when something happens on the PR.

Then follow the **monitor-pr** skill: act on every report, and — unless `keepAlive` is disabled in `.claude/pr-monitor.json` — keep the session on the PR until it is handed off with `mark_ready`, waiting between events rather than ending the turn.
