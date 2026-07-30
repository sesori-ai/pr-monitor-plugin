---
name: monitor-pr
description: Drive a GitHub PR to ready-for-human-review without supervision. Start a background monitor with the pr_monitor tool immediately after opening a PR, act on every incoming "[PR Monitor]" report (review comments, failing CI, merge conflicts), label the PR ready when everything is green, and pick the work back up when a human responds. Use right after `gh pr create`, when asked to monitor/watch a PR, and whenever a "[PR Monitor]" report or "[PR Monitor keep-alive]" message appears.
---

# monitor-pr

Own a PR from the moment it is opened until a human needs to look at it, then
hand it over — and take it back if the human responds.

The `pr_monitor` tool watches the PR in the background and delivers factual
`[PR Monitor]` reports into this session. This skill is what turns those
reports into work.

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
  lives in `.claude/pr-monitor.json` or `.opencode/pr-monitor.json` — never in
  tool arguments.

## 2. Handle each `[PR Monitor]` report

Reports state facts only. Address **everything** in a report in one batch:

| Report says | Do this |
| --- | --- |
| `CI: failing (…)` | Inspect (`gh pr checks <pr> --repo owner/repo`, `gh run view <run-id> --log-failed --repo owner/repo`), fix the root cause, commit and push. Never delete or weaken tests to go green. |
| `Mergeable: CONFLICTING` | Merge the base branch INTO the PR branch. Resolve the real base first: `gh pr view <n> --repo owner/repo --json baseRefName -q .baseRefName`, then `git fetch origin && git merge origin/<baseRefName>`. **Never rebase, never force push.** Resolve conservatively so both sides' functionality survives, run the relevant tests, push the merge commit. |
| New inline comments / `changes_requested` | Follow the repo's `address-pr-comments` skill: fetch unresolved threads, assess validity, fix, reply to every thread, resolve what you fixed. If the repo has no such skill, do the same by hand via `gh api`. |
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
the **handoff**: monitoring continues, but the PR stops holding this session
open. Report it to the user in one line and finish.

Do not hand off early. A PR with CI still running, an unanswered thread, or a
reviewer that has not reported yet is not ready — wait instead (step 4).

## 4. Waiting is the job

Between events there is nothing to do but wait, and waiting is expected — a
quiet PR is not a reason to finish. When a turn would end while a monitored PR
is still yours, a `[PR Monitor keep-alive]` message asks you to keep going. It
carries the exact command to run:

```
node "<plugin>/hooks/await-activity.mjs" --session <pid> --timeout 540
```

Run it with the Bash tool and `timeout: 600000`. It blocks until a report lands
(the report is injected automatically right after), until monitoring finishes,
or until it times out — then reassess and, if there is still nothing to do, wait
again.

If the user asks you to stop, or wants your attention elsewhere, call
`pr_monitor(action: "stop", pr: "all")` and follow the user. The user always
wins over the loop.

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
