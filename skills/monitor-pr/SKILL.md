---
name: monitor-pr
description: >-
  Drive a GitHub PR to ready-for-human-review without supervision. Start
  pr_monitor immediately after opening a PR and act on every automatic report;
  the monitor owns polling, so never create sleeps, scheduled checks, or polling
  loops. Address review comments, failing CI, and conflicts, label the PR ready
  only after mark_ready confirms success, and take work back when a human
  responds. Use after raising a PR, when asked to watch one, and whenever a
  "[PR Monitor]" message appears.
---

# monitor-pr

Own a PR from the moment it is opened until a human needs to look at it, then
hand it over — and take it back if the human responds.

The `pr_monitor` tool owns GitHub polling and delivers factual `[PR Monitor]`
reports into this session automatically. This skill turns those reports into
work; it must never create a second waiting or polling mechanism.

## The loop

```
open PR ─▶ start ─▶ ┌─ report ─▶ address everything ─┐
                     └────── still not clean ◀────────┘
                                                     │ clean
                                                     ▼
                                              mark_ready (handoff)
                                                     │
                                    human comments ──┘
                                          │
                            unmark_ready ─┘ ──▶ back into the loop
```

## 1. Start monitoring immediately

Right after raising a PR, without waiting for another prompt:

```
pr_monitor(action: "start", pr: "owner/repo#123")
```

- `pr` is always explicit: `owner/repo#123` or a full PR URL, never a bare number.
- Start one monitor for each PR.
- Monitors are session-scoped and do not survive a session replacement or host
  restart. In a fresh session, use `status` once and restart anything missing.
- Tuning lives in repository `.pr-monitor.json`, the host config directory's
  `pr-monitor.json`, or `.opencode/pr-monitor.json`, never in tool arguments.

## 2. Handle every `[PR Monitor]` report

Reports state facts only. Address everything in a report in one batch:

- **`CI: failing (…)`:** Inspect with `gh pr checks` and
  `gh run view --log-failed`, fix the root cause, test, commit, and push. Never
  delete or weaken tests to make CI green.
- **`Mergeable: CONFLICTING`:** Resolve the real base with
  `gh pr view --json baseRefName`, then fetch and merge
  `origin/<baseRefName>` into the PR branch. Never rebase or force-push.
  Preserve both sides, test, and push the merge commit.
- **Threads received new comments / `changes_requested`:** Follow the
  repository's PR-comment skill when available. Inspect recent comments across
  every thread, including resolved threads. Validate each comment, fix valid
  findings, reply, and resolve what was fixed.
- **New issue comments:** Read them with `gh pr view --comments` and act only
  when they request work.
- **`CI: running (… failed so far …)`:** A check is already red. Start on the
  named failure exactly as for `CI: failing`; do not wait for the suite.
- **`CI: running` with no failure:** End the turn and let the monitor notify you.
- **`— MERGED` / `— CLOSED`:** The monitor stopped itself. Done.

A delivered report already advances the "new since last flush" baseline. Never
call `flush` routinely after handling one.

Comments from the account used to push are not necessarily agent-authored. The
agent's own replies are filtered only when they contain the configured
`ignoreCommentTag`; any owner-account comment that reaches a report may be a
human instruction and must be inspected.

An unchanged unresolved-thread count does not mean there is no new feedback.
When a report says a thread received comments, inspect it even if that thread is
currently resolved or was answered before.

## 3. Hand off only when genuinely clean

Mark the PR ready only when the latest report shows all of:

- `CI: passing`, or `CI: none` when the repository has no checks;
- `Mergeable: MERGEABLE`;
- zero unresolved threads;
- no pending requested reviewers;
- no outstanding `changes_requested`; and
- every review comment answered. A reasoned declined finding with a reply is
  answered even if its thread remains unresolved intentionally.

Then call:

```
pr_monitor(action: "mark_ready", pr: "owner/repo#123")
```

This adds the configured `readyLabel` on GitHub. It is a handoff only after the
tool confirms success. Report the handoff to the user in one line and end the
turn. If `mark_ready` fails, do not claim success: diagnose the GitHub or config
error and retry while the monitor remains active.

Do not hand off while CI is running, a reviewer is pending, or feedback remains
unanswered.

## 4. Never invent a wait

The monitor owns polling and notifications arrive automatically. Never run
`sleep`, delayed Bash, cron, a scheduled job, a background polling loop,
repeated `gh pr checks`, or routine `pr_monitor status`/`flush` calls while
waiting for CI or review. Do not launch a waiter immediately after `start`.

When there is no delivered report to act on, end the turn. The host's native
message delivery wakes this session when activity arrives. If the user asks you
to stop or work elsewhere, call `pr_monitor(action: "stop", pr: "all")`; the
user always wins over this loop.

## 5. Take handed-off work back

A handed-off PR remains monitored. When a human comments, requests changes, or
pushes, the next report makes the PR your job again:

1. Call `pr_monitor(action: "unmark_ready", pr: "owner/repo#123")` first so the
   PR no longer advertises itself as ready while work is active.
2. Handle the report exactly as in step 2.
3. Re-check step 3 and hand off again when clean.

The report's `Labels` line shows whether the configured ready label is present.

## Other actions

- `status`: list this session's monitors. Use deliberately, not as a wait loop.
- `flush`: request a full status report now. Never call it routinely after a
  delivered report.
- `stop`: stop one monitor or all monitors without waiting for merge.

## Avoid the bot-review spiral

Every push can trigger another AI review. A bot-reported edge case earns a code
change only when it is plausible in a real flow and has a real consequence.
Contrived cases get a reasoned reply instead. If several rounds cluster on one
structural seam, fix the seam once or surface it to the user rather than
patching point by point.
