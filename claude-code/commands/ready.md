---
description: Mark a GitHub PR as ready for human review (adds a label)
argument-hint: "[owner/repo#123 | PR URL]"
---

Mark a PR as ready for human review with the pr_monitor tool (action "mark_ready"). This adds the configured ready label (default `ready-for-human-review`, config key `readyLabel`) to the PR on GitHub so a human knows it is their turn.

PR to mark: $ARGUMENTS

If no PR was given above, resolve the current branch's open PR with `gh pr view --json url -q .url` and mark that one. The pr argument passed to the tool must be explicit — `owner/repo#123` or a full PR URL.

After marking, briefly confirm the label was added.
