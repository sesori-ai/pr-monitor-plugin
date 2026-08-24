---
name: monitor-pr
description: Drive a GitHub PR to ready-for-human-review without supervision. Start pr_monitor immediately after opening a PR and act on every automatic report; the monitor owns polling, so never create sleeps, scheduled checks, or polling loops. Address review comments, failing CI, and conflicts, label the PR ready only after mark_ready confirms success, and take work back when a human responds. Use after `gh pr create`, when asked to watch a PR, and whenever a "[PR Monitor]" or "[PR Monitor keep-alive]" message appears.
---

# monitor-pr

Own a PR from the moment it is opened until a human needs to look at it, then
hand it over — and take it back if the human responds.

The `pr_monitor` tool owns GitHub polling and delivers factual `[PR Monitor]`
reports into this session automatically. This skill turns those reports into
work; it must never create a second waiting or polling mechanism.

## The loop

```
open PR ──▶ start monitor ──▶ ┌─ report arrives ──▶ address everything in it ─┐
                              │                                              │
                              └────────────── still not clean ◀──────────────┘
                                                     │ clean
                                                     ▼
                                              mark_ready (handoff)
                                                     │
                                    human comments ──┘
                                          │
                            unmark_ready ─┘ ──▶ back into the loop
```

## 1. Start monitoring — always, and immediately

**Right after raising a PR** (e.g. after `gh pr create`), with no prompting:

```
pr_monitor(action: "start", pr: "owner/repo#123")
```

- `pr` is always explicit — `owner/repo#123` or a full PR URL. Never a bare number.
- One monitor per PR; start several for several PRs.
- Monitors are per-session and **do not survive a restart**. When resuming PR
  work in a fresh session, run `pr_monitor(action: "status")` and re-start what
  is missing.
- Tuning (debounce, poll interval, CI wait, ignored comment tag, keep-alive)
  lives in `.pr-monitor.json`, with `.claude/pr-monitor.json` and
  `.opencode/pr-monitor.json` as fallbacks — never in tool arguments.

## 2. Handle each `[PR Monitor]` report

Reports state facts only. Address **everything** in a report in one batch:

| Report says | Do this |
| --- | --- |
| `CI: failing (…)` | Inspect (`gh pr checks <pr> --repo owner/repo`, `gh run view <run-id> --log-failed --repo owner/repo`), fix the root cause, commit and push. Never delete or weaken tests to go green. |
| `Mergeable: CONFLICTING` | Merge the base branch INTO the PR branch. Resolve the real base first: `gh pr view <n> --repo owner/repo --json baseRefName -q .baseRefName`, then `git fetch origin && git merge origin/<baseRefName>`. **Never rebase, never force push.** Resolve conservatively so both sides' functionality survives, run the relevant tests, push the merge commit. |
| Threads received new inline comments / `changes_requested` | Follow the repo's `address-pr-comments` skill, but fetch recent comments across **all** review threads, not only unresolved ones. A follow-up can land on a thread that was already answered or resolved. Reassess the new comment, fix when valid, reply, and resolve what you fixed. If the repo has no such skill, do the same by hand via `gh api`. |
| New issue comments | Read them (`gh pr view <n> --repo owner/repo --comments`) and act only if they ask for something. |
| `CI: running (… 1 failed so far: …)` | A check has already gone red — the monitor sends this straight away instead of waiting for the suite. Start on the named check now exactly as for `CI: failing`; do not wait for the rest of the suite to finish. |
| `CI: running` with nothing failed | Nothing to do yet — wait (step 4). The monitor holds reports while CI runs. |
| `— MERGED` / `— CLOSED` | The monitor stopped itself. Done. |

A delivered report has **already advanced** the "new since last flush" baseline,
so handled activity is not echoed back. Do **not** call `flush` as a routine
step after handling a report.

> **Comments from the account you push with are NOT necessarily your own.**
> The agent often pushes and replies using the same GitHub account as the human
> owner. Agent replies carry the configured `ignoreCommentTag` prefix (e.g.
> `[Sesori reply]`) and are filtered out of reports entirely. So any
> owner-account comment that reaches you **is a human instruction** — fetch it
> and act on it, including when it overrides a decision you already made.

The unresolved-thread total is not a proxy for new feedback. If the report says
that one or more threads received new comments, inspect those recent comments
even when the total did not change or the report says the affected thread is
currently resolved. Do not treat your earlier reply or resolution as handling a
later comment.

## 3. Hand off when — and only when — it is genuinely clean

Mark the PR ready once the latest report shows **all** of:

- `CI: passing` (or `CI: none` if the repo has no checks)
- `Mergeable: MERGEABLE`
- `0 unresolved threads`
- No `⏳ pending` reviewers left — the AI reviewers have finished
- No outstanding `✗ changes_requested`
- Every review comment answered (the `address-pr-comments` skill leaves declined
  threads unresolved on purpose — those count as answered, not as outstanding,
  once they carry a reply)

Then:

```
pr_monitor(action: "mark_ready", pr: "owner/repo#123")
```

This adds the `readyLabel` (default `ready-for-human-review`) on GitHub and is
the **handoff** only after the tool confirms success. Monitoring continues, but
the PR stops holding this session open. Report it to the user in one line and
finish. If `mark_ready` fails, do not claim handoff or finish: diagnose the
GitHub/config error and retry; keep-alive remains armed.

Do not hand off early. A PR with CI still running, an unanswered thread, or a
reviewer that has not reported yet is not ready — wait instead (step 4).

## 4. Never invent a wait

The monitor owns polling and notifications arrive automatically. **NEVER** run
`sleep`, delayed Bash, a scheduled/cron job, a background polling loop, repeated
`gh pr checks`, or routine `pr_monitor status`/`flush` calls while waiting for
CI or review. Do not proactively run a waiter immediately after `start`.

When a turn would end while a monitored PR is still yours, the plugin may inject
a `[PR Monitor keep-alive]` message containing this exact event waiter:

```
node "<plugin>/hooks/await-activity.mjs" --session <pid> --timeout 540
```

That hook-issued command is the **only** allowed waiting mechanism. Run it only
when the keep-alive message asks, with the Bash tool and `timeout: 600000`. It
blocks until a report is ready (and the next hook injects it), monitoring ends,
or it times out. Never substitute or layer another delay around it.

If no keep-alive message asks for that command, end the turn; do not manufacture
work while the monitor waits. If the user asks you to stop or wants your
attention elsewhere, call `pr_monitor(action: "stop", pr: "all")` and follow
the user. The user always wins over the loop.

## 5. Taking the PR back

A PR that was handed off keeps being monitored. When a human leaves a comment,
requests changes, or pushes to it, a new report arrives and the PR becomes your
job again. In that case:

1. `pr_monitor(action: "unmark_ready", pr: "owner/repo#123")` — withdraw the
   label first, so the PR stops advertising itself as awaiting review while you
   work on it.
2. Work the report exactly as in step 2.
3. Re-check step 3 and hand off again when it is clean.

The `- Labels:` line in each report tells you whether the ready label is
currently on the PR, which is how you recognise this case after a `/clear` or in
a fresh session.

## Other actions

- `pr_monitor(action: "status")` — this session's monitors, and whether each is handed off.
- `pr_monitor(action: "flush", pr: "…" | "all")` — force a full status report right now. Only when you deliberately want current state; never as a routine step after handling a report.
- `pr_monitor(action: "stop", pr: "…" | "all")` — stop watching without waiting for merge.

## Avoid the bot-review spiral

Every push can trigger a fresh round of AI-reviewer comments, and fixing those
spawns the next round. Raise the bar each round: a bot-reported edge case earns
a code change only when it is plausible in a real flow **and** has a real
consequence. Contrived cases get a reasoned "not addressed" reply — that is a
valid resolution, not a failure. If several rounds cluster on the same
structural seam, fix the seam once or surface it to the user instead of patching
point by point.
