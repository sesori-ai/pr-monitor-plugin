import { ciPhase, type CommentMeta, type PrSnapshot } from "./github"

function commentSig(comments: CommentMeta[]): string {
  const last = comments[comments.length - 1]
  return `${comments.length}:${last?.createdAt ?? ""}`
}

function reviewSig(snapshot: PrSnapshot): string {
  const states = snapshot.reviews.map((review) => `${review.login}=${review.state}@${review.submittedAt}`).sort()
  const pending = [...snapshot.pendingReviewers].sort()
  return `${states.join(",")}|${pending.join(",")}`
}

function ciConcludedSig(snapshot: PrSnapshot): string {
  const failed = snapshot.checks
    .filter((check) => check.outcome === "failure")
    .map((check) => check.name)
    .sort()
  return `${snapshot.headSha}:${failed.join(",")}`
}

/**
 * True when mergeability changed in a report-worthy way. Only transitions
 * between the two definite states (MERGEABLE <-> CONFLICTING) count. GitHub
 * recomputes mergeability whenever the base branch advances (e.g. another PR
 * merges), churning the field through the transient UNKNOWN state
 * (MERGEABLE -> UNKNOWN -> MERGEABLE). Those transitions are noise: unless the
 * PR actually settles into CONFLICTING, a base-branch merge should not notify.
 */
function mergeableChanged(prev: PrSnapshot, next: PrSnapshot): boolean {
  if (prev.mergeable === "UNKNOWN" || next.mergeable === "UNKNOWN") return false
  return prev.mergeable !== next.mergeable
}

/** True when something report-worthy changed between consecutive polls. */
export function detectActivity(prev: PrSnapshot, next: PrSnapshot): boolean {
  if (prev.state !== next.state) return true
  if (mergeableChanged(prev, next)) return true
  if (reviewSig(prev) !== reviewSig(next)) return true
  if (prev.unresolvedThreads !== next.unresolvedThreads) return true
  if (commentSig(prev.inlineComments) !== commentSig(next.inlineComments)) return true
  if (prev.issueCommentsTotal !== next.issueCommentsTotal || commentSig(prev.issueComments) !== commentSig(next.issueComments)) return true
  // CI: only suite conclusion counts. Transitions into "running" (new push)
  // and per-check progress are intentionally NOT activity.
  if (ciPhase(next) === "concluded" && (ciPhase(prev) !== "concluded" || ciConcludedSig(prev) !== ciConcludedSig(next))) return true
  return false
}
