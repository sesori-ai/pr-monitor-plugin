---
description: Mark a GitHub PR as ready for human review (adds a label)
argument-hint: "[owner/repo#123 | PR URL]"
---

Manually accept a PR's current state with the pr_monitor tool (action "mark_ready"). This unconditionally adds the
configured ready label (default `ready-for-human-review`, config key `readyLabel`) and records all activity already
observed by an active watch as accepted. Use it when new activity, such as a bot acknowledgement, is non-actionable
and should not receive another reply.

PR to mark: $ARGUMENTS

If no PR was given above, resolve the current branch's open PR with `gh pr view --json url -q .url` and mark that one. The pr argument passed to the tool must be explicit — `owner/repo#123` or a full PR URL.

Briefly confirm handoff only if the tool reports that the label was added. On failure, diagnose and retry; do not claim the PR is ready.
