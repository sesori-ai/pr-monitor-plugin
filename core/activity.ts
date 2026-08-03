import { ciPhase, type CommentMeta, type PrSnapshot, type ReviewThreadInfo } from "./github"

function reviewSig(snapshot: PrSnapshot): string {
  const states = snapshot.reviews.map((review) => `${review.login}=${review.state}@${review.submittedAt}`).sort()
  const pending = [...snapshot.pendingReviewers].sort()
  return `${states.join(",")}|${pending.join(",")}`
}

function hasAddedComment(prev: CommentMeta[], next: CommentMeta[]): boolean {
  const before = new Set(prev.map((comment) => comment.id))
  return next.some((comment) => !before.has(comment.id))
}

function reviewThreadsChanged(prev: ReviewThreadInfo[], next: ReviewThreadInfo[]): boolean {
  const before = new Map(prev.map((thread) => [thread.id, thread]))
  const after = new Set(next.map((thread) => thread.id))
  if (prev.some((thread) => !after.has(thread.id))) return true
  return next.some((thread) => {
    const previous = before.get(thread.id)
    if (!previous) return !thread.isResolved || thread.comments.length > 0
    return previous.isResolved !== thread.isResolved || hasAddedComment(previous.comments, thread.comments)
  })
}

function ciConcludedSig(snapshot: PrSnapshot): string {
  const failed = snapshot.checks
    .filter((check) => check.outcome === "failure")
    .map((check) => check.name)
    .sort()
  return `${snapshot.headSha}:${failed.join(",")}`
}

/**
 * True when mergeability settled into a new definite state. Only transitions
 * between the two definite states (MERGEABLE <-> CONFLICTING) count. GitHub
 * recomputes mergeability whenever the base branch advances (e.g. another PR
 * merges), churning the field through the transient UNKNOWN state
 * (MERGEABLE -> UNKNOWN -> MERGEABLE). Those transitions are noise: unless the
 * PR actually settles into CONFLICTING, a base-branch merge should not notify.
 *
 * `lastDefinite` is the most recent MERGEABLE/CONFLICTING value observed, which
 * is NOT necessarily `prev.mergeable`: a real MERGEABLE -> UNKNOWN -> CONFLICTING
 * settle spans two polls, and on the second poll `prev` is the transient UNKNOWN.
 * Comparing against the last definite state (rather than the immediately
 * previous snapshot) keeps the UNKNOWN churn quiet while still catching the
 * genuine conflict once it resolves.
 */
function mergeableChanged(lastDefinite: PrSnapshot["mergeable"] | undefined, next: PrSnapshot): boolean {
  if (next.mergeable === "UNKNOWN") return false
  if (lastDefinite === undefined) return false
  return lastDefinite !== next.mergeable
}

/** True when a conflict is newly observed, including after an initial UNKNOWN. */
export function hasNewMergeConflict(
  lastDefinite: PrSnapshot["mergeable"] | undefined,
  next: PrSnapshot,
): boolean {
  return next.state === "OPEN" && next.mergeable === "CONFLICTING" && lastDefinite !== "CONFLICTING"
}

/**
 * True when `next` shows a failing check that `prev` did not — including the
 * case where CI is still running, which `detectActivity` deliberately ignores.
 * A new head SHA makes every failure on it new (the previous SHA's outcomes say
 * nothing about this commit).
 *
 * Used for the instant CI-failure flush, which is the one case where a report
 * should not wait for the debounce window: the failure is actionable on its own
 * and the session can start fixing it while the rest of the suite runs.
 */
export function hasNewCiFailure(prev: PrSnapshot, next: PrSnapshot): boolean {
  const failing = next.checks.filter((check) => check.outcome === "failure")
  if (failing.length === 0) return false
  if (prev.headSha !== next.headSha) return true
  const before = new Set(prev.checks.filter((check) => check.outcome === "failure").map((check) => check.name))
  return failing.some((check) => !before.has(check.name))
}

/**
 * True when something report-worthy changed between consecutive polls.
 *
 * `lastDefiniteMergeable` is the caller-tracked last MERGEABLE/CONFLICTING value
 * (see `mergeableChanged`); pass `undefined` when no definite state has been
 * observed yet.
 */
export function detectActivity(prev: PrSnapshot, next: PrSnapshot, lastDefiniteMergeable: PrSnapshot["mergeable"] | undefined): boolean {
  if (prev.state !== next.state) return true
  if (mergeableChanged(lastDefiniteMergeable, next)) return true
  if (reviewSig(prev) !== reviewSig(next)) return true
  if (reviewThreadsChanged(prev.reviewThreads, next.reviewThreads)) return true
  if (prev.issueCommentsTotal !== next.issueCommentsTotal || hasAddedComment(prev.issueComments, next.issueComments)) return true
  // CI: only suite conclusion counts. Transitions into "running" (new push)
  // and per-check progress are intentionally NOT activity.
  if (ciPhase(next) === "concluded" && (ciPhase(prev) !== "concluded" || ciConcludedSig(prev) !== ciConcludedSig(next))) return true
  return false
}
