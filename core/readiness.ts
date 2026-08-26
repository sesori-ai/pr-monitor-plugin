import {
  hasAddedRelevantComment,
  hasNewCiFailure,
  hasNewMergeConflict,
  reviewThreadsReceivedNewComments,
} from "./activity"
import { ciPhase, type CommentMeta, type PrSnapshot } from "./github"

export type AutomaticReadiness = {
  eligible: boolean
  blockers: string[]
  awaitingThreadReplies: number
  awaitingUnthreadedReply: boolean
}

function latestComment(comments: CommentMeta[]): CommentMeta | undefined {
  return comments.reduce<CommentMeta | undefined>((latest, comment) => {
    if (latest === undefined) return comment
    const latestAt = Date.parse(latest.createdAt)
    const commentAt = Date.parse(comment.createdAt)
    if (Number.isNaN(latestAt) || Number.isNaN(commentAt)) return comment
    return commentAt >= latestAt ? comment : latest
  }, undefined)
}

export function ciIsReady(snapshot: PrSnapshot): boolean {
  const phase = ciPhase(snapshot)
  return phase === "none" || (phase === "concluded" && snapshot.checks.every((check) => check.outcome === "success"))
}

export function assessAutomaticReadiness(snapshot: PrSnapshot): AutomaticReadiness {
  const blockers: string[] = []
  if (snapshot.state !== "OPEN") blockers.push(`PR is ${snapshot.state.toLowerCase()}`)
  if (!ciIsReady(snapshot)) {
    blockers.push(ciPhase(snapshot) === "running" ? "CI is running" : "CI is failing")
  }
  if (snapshot.mergeable !== "MERGEABLE") {
    blockers.push(
      snapshot.mergeable === "CONFLICTING"
        ? "the PR has a merge conflict"
        : "mergeability is still unknown",
    )
  }

  const awaitingThreadReplies = snapshot.reviewThreads.filter(
    (thread) => latestComment(thread.comments)?.isAgentReply !== true,
  ).length
  if (awaitingThreadReplies > 0) {
    blockers.push(
      `${awaitingThreadReplies} review ${awaitingThreadReplies === 1 ? "thread awaits" : "threads await"} ` +
        "a prefixed reply from the local GitHub account",
    )
  }

  const latestUnthreaded = latestComment([...snapshot.issueComments, ...snapshot.reviewSummaries])
  const awaitingUnthreadedReply = latestUnthreaded !== undefined && !latestUnthreaded.isAgentReply
  if (awaitingUnthreadedReply) {
    blockers.push("issue or review-summary feedback awaits a prefixed reply from the local GitHub account")
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    awaitingThreadReplies,
    awaitingUnthreadedReply,
  }
}

export function hasReadyLabel(snapshot: PrSnapshot, readyLabel: string): boolean {
  const normalized = readyLabel.toLowerCase()
  return snapshot.labels.some((label) => label.toLowerCase() === normalized)
}

export function withReadyLabel(snapshot: PrSnapshot, readyLabel: string, ready: boolean): PrSnapshot {
  const normalized = readyLabel.toLowerCase()
  const withoutReady = snapshot.labels.filter((label) => label.toLowerCase() !== normalized)
  return { ...snapshot, labels: ready ? [...withoutReady, readyLabel] : withoutReady }
}

/**
 * A present ready label accepts the snapshot at which it was observed or
 * manually applied. Only later negative activity withdraws it, which lets a
 * manual mark override any current state without being undone on the next poll.
 */
export function hasReadinessInvalidation(
  prev: PrSnapshot,
  next: PrSnapshot,
  lastDefiniteMergeable: PrSnapshot["mergeable"] | undefined,
): boolean {
  if (next.state !== "OPEN") return false
  if (prev.headSha !== next.headSha) return true
  if (hasNewMergeConflict(lastDefiniteMergeable, next)) return true
  if (ciIsReady(prev) && !ciIsReady(next)) return true
  if (hasNewCiFailure(prev, next)) return true
  if (reviewThreadsReceivedNewComments(prev.reviewThreads, next.reviewThreads)) return true
  if (hasAddedRelevantComment(prev.issueComments, next.issueComments)) return true
  if (hasAddedRelevantComment(prev.reviewSummaries, next.reviewSummaries)) return true
  return false
}
