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

function latestComments(comments: CommentMeta[]): CommentMeta[] {
  let latestAt = Number.NEGATIVE_INFINITY
  let latest: CommentMeta[] = []
  for (const comment of comments) {
    const createdAt = Date.parse(comment.createdAt)
    // GitHub timestamps are expected to parse. If one does not, keep every
    // entry in contention rather than accidentally accepting hidden feedback.
    if (Number.isNaN(createdAt)) return comments
    if (createdAt > latestAt) {
      latestAt = createdAt
      latest = [comment]
    } else if (createdAt === latestAt) {
      latest.push(comment)
    }
  }
  return latest
}

function channelIsAcknowledged(comments: CommentMeta[]): boolean {
  // GitHub timestamps can collide at one-second precision. A mixed tie remains
  // unacknowledged until a later prefixed reply removes the ambiguity.
  return comments.length > 0 && latestComments(comments).every((comment) => comment.isAgentReply)
}

function feedbackChannels(snapshot: PrSnapshot): Map<string, CommentMeta[]> {
  const channels = new Map<string, CommentMeta[]>()
  channels.set("unthreaded", [...snapshot.issueComments, ...snapshot.reviewSummaries])
  for (const thread of snapshot.reviewThreads) channels.set(`thread:${thread.id}`, thread.comments)
  return channels
}

export function hasAcknowledgementRegression(prev: PrSnapshot, next: PrSnapshot): boolean {
  const before = feedbackChannels(prev)
  return [...feedbackChannels(next)].some(([channel, comments]) => {
    const previous = before.get(channel)
    if (channel === "unthreaded") {
      return comments.length > 0 && channelIsAcknowledged(previous ?? []) && !channelIsAcknowledged(comments)
    }
    // A present empty thread is conservatively unacknowledged. Its appearance,
    // or deletion of its last prefixed reply, must therefore revoke readiness.
    return !channelIsAcknowledged(comments) &&
      (previous === undefined || channelIsAcknowledged(previous))
  })
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
    (thread) => !channelIsAcknowledged(thread.comments),
  ).length
  if (awaitingThreadReplies > 0) {
    blockers.push(
      `${awaitingThreadReplies} review ${awaitingThreadReplies === 1 ? "thread awaits" : "threads await"} ` +
        "a prefixed reply from the local GitHub account",
    )
  }

  const unthreaded = [...snapshot.issueComments, ...snapshot.reviewSummaries]
  const awaitingUnthreadedReply = unthreaded.length > 0 && !channelIsAcknowledged(unthreaded)
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
  if (hasAcknowledgementRegression(prev, next)) return true
  if (reviewThreadsReceivedNewComments(prev.reviewThreads, next.reviewThreads)) return true
  if (hasAddedRelevantComment(prev.issueComments, next.issueComments)) return true
  if (hasAddedRelevantComment(prev.reviewSummaries, next.reviewSummaries)) return true
  return false
}
