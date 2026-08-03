// Report rendering: facts only — no advice, no comment bodies, just counts
// and authors. "New" means absent from the last successfully flushed snapshot;
// standalone initial reports fall back to their timestamp baseline.

import { ciPhase, type CommentMeta, type PrSnapshot } from "./github"
import { targetKey, type Target } from "./target"

function authorBreakdown(comments: CommentMeta[]): string {
  const counts = new Map<string, number>()
  for (const comment of comments) {
    const name = comment.isBot ? `${comment.author}[bot]` : comment.author
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${count} ${name}`)
    .join(", ")
}

function newSince(comments: CommentMeta[], baselineMs: number, baselineComments?: CommentMeta[]): CommentMeta[] {
  if (baselineComments !== undefined) {
    const seen = new Set(baselineComments.map((comment) => comment.id))
    return comments.filter((comment) => !seen.has(comment.id))
  }
  return comments.filter((comment) => Date.parse(comment.createdAt) > baselineMs)
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`
}

function inlineLine(snapshot: PrSnapshot, baselineMs: number, baseline?: PrSnapshot): string {
  const unresolved = snapshot.reviewThreads.filter((thread) => !thread.isResolved).length
  const before = new Map(baseline?.reviewThreads.map((thread) => [thread.id, thread.comments]) ?? [])
  const changed = snapshot.reviewThreads
    .map((thread) => ({
      thread,
      comments: newSince(thread.comments, baselineMs, baseline ? before.get(thread.id) ?? [] : undefined),
    }))
    .filter((item) => item.comments.length > 0)
  if (changed.length === 0) {
    return `- [comment:inline] ${countLabel(unresolved, "unresolved thread")}; 0 threads received new comments since last flush`
  }

  const fresh = changed.flatMap((item) => item.comments)
  const changedUnresolved = changed.filter((item) => !item.thread.isResolved).length
  const changedResolved = changed.length - changedUnresolved
  const states = [
    changedUnresolved > 0 ? `${changedUnresolved} currently unresolved` : undefined,
    changedResolved > 0 ? `${changedResolved} currently resolved` : undefined,
  ].filter((part): part is string => part !== undefined)
  return (
    `- [comment:inline] ${countLabel(unresolved, "unresolved thread")}; ` +
    `${countLabel(changed.length, "thread")} received ${countLabel(fresh.length, "new comment")} since last flush ` +
    `(${states.join(", ")}; ${authorBreakdown(fresh)})`
  )
}

function ciLine(snapshot: PrSnapshot, forcedHoldMinutes: number | undefined): string {
  const phase = ciPhase(snapshot)
  if (phase === "none") return "- CI: none"
  const total = snapshot.checks.length
  const failed = snapshot.checks.filter((check) => check.outcome === "failure")
  const pending = snapshot.checks.filter((check) => check.outcome === "pending")
  if (phase === "concluded") {
    if (failed.length === 0) return `- CI: passing (${total}/${total})`
    return `- CI: failing (${failed.length}/${total} failed: ${failed.map((check) => check.name).join(", ")})`
  }
  if (forcedHoldMinutes !== undefined) {
    return `- CI: running for ${forcedHoldMinutes}m+ (in_progress: ${pending.map((check) => check.name).join(", ")})`
  }
  const done = total - pending.length
  const failedPart = failed.length > 0 ? `, ${failed.length} failed so far: ${failed.map((check) => check.name).join(", ")}` : ""
  return `- CI: running (${done}/${total} done${failedPart})`
}

function reviewLine(snapshot: PrSnapshot): string {
  const MARKS: Record<string, string> = {
    APPROVED: "✓ approved",
    CHANGES_REQUESTED: "✗ changes_requested",
    COMMENTED: "✦ commented",
    DISMISSED: "⊘ dismissed",
  }
  const parts = snapshot.reviews.map((review) => `${review.login} ${MARKS[review.state] ?? review.state.toLowerCase()}`)
  for (const login of snapshot.pendingReviewers) parts.push(`${login} ⏳ pending`)
  return `- Reviews: ${parts.length > 0 ? parts.join(" · ") : "none"}`
}

export function buildReport(
  target: Target,
  snapshot: PrSnapshot,
  opts: { baselineMs: number; baselineSnapshot?: PrSnapshot; forcedHoldMinutes?: number },
): string {
  const stateSuffix = snapshot.state !== "OPEN" ? ` — ${snapshot.state}` : ""
  const title = snapshot.title.replace(/\s+/g, " ").trim()
  const newIssue = newSince(snapshot.issueComments, opts.baselineMs, opts.baselineSnapshot?.issueComments)
  const newPart = (fresh: CommentMeta[]): string =>
    fresh.length > 0 ? `${fresh.length} new since last flush: ${authorBreakdown(fresh)}` : "0 new since last flush"
  const lines = [
    `[PR Monitor] [${targetKey(target)}](${snapshot.url}) — "${title}"${stateSuffix}`,
    ciLine(snapshot, opts.forcedHoldMinutes),
    `- Mergeable: ${snapshot.mergeable}`,
    reviewLine(snapshot),
    inlineLine(snapshot, opts.baselineMs, opts.baselineSnapshot),
    `- [comment:issue] ${snapshot.issueCommentsTotal} total (${newPart(newIssue)})`,
  ]
  // Reported so a session can see whether the PR is already handed off to a
  // human (ready label present). Deliberately NOT part of detectActivity: the
  // agent applies and removes that label itself, and treating it as activity
  // would make every mark_ready trigger a report that re-opens the work loop.
  if (snapshot.labels.length > 0) lines.push(`- Labels: ${snapshot.labels.join(", ")}`)
  if (snapshot.state !== "OPEN") lines.push(`- Monitor stopped: PR ${snapshot.state === "MERGED" ? "merged" : "closed"}`)
  return lines.join("\n")
}
