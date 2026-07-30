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
  if (prev.unresolvedThreads !== next.unresolvedThreads) return true
  if (commentSig(prev.inlineComments) !== commentSig(next.inlineComments)) return true
  if (prev.issueCommentsTotal !== next.issueCommentsTotal || commentSig(prev.issueComments) !== commentSig(next.issueComments)) return true
  // CI: only suite conclusion counts. Transitions into "running" (new push)
  // and per-check progress are intentionally NOT activity.
  if (ciPhase(next) === "concluded" && (ciPhase(prev) !== "concluded" || ciConcludedSig(prev) !== ciConcludedSig(next))) return true
  return false
}
