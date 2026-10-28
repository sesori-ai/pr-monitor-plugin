// On-demand review feedback: the comment bodies that reports deliberately omit, limited to the channels that
// automatic readiness still counts as unanswered, plus a prefixed reply helper so agents never hand-build the
// acknowledgement the monitor looks for.

import { type CommentMeta, fetchPrPayload, type GhRunner, normalizeSnapshot, parseGhPayload } from "./github"
import { channelIsAcknowledged } from "./readiness"
import { targetKey, type Target } from "./target"

// ponytail: per-comment cap keeps one huge bot dump from flooding the context; raise it if agents miss detail.
const MAX_BODY_CHARS = 4000

function collectBodies(payload: unknown): Map<string, string> {
  const pr = (payload as any)?.data?.repository?.pullRequest
  const bodies = new Map<string, string>()
  const add = (node: any) => {
    if (typeof node?.id === "string" && typeof node.body === "string") bodies.set(node.id, node.body)
  }
  for (const review of pr?.latestReviews?.nodes ?? []) add(review)
  for (const thread of pr?.reviewThreads?.nodes ?? []) for (const comment of thread.comments?.nodes ?? []) add(comment)
  for (const comment of pr?.comments?.nodes ?? []) add(comment)
  return bodies
}

// Comments at or after the latest agent reply: earlier ones were answered. A same-second tie stays visible because
// readiness also treats it as unanswered.
function unanswered(comments: CommentMeta[]): CommentMeta[] {
  const replyTimes = comments.filter((comment) => comment.isAgentReply).map((comment) => Date.parse(comment.createdAt))
  const lastReply = replyTimes.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...replyTimes)
  return comments
    .filter((comment) => !comment.isAgentReply && !(Date.parse(comment.createdAt) < lastReply))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

function renderComment(comment: CommentMeta, bodies: Map<string, string>): string {
  const raw = (bodies.get(comment.id) ?? "").replace(/<!--[\s\S]*?-->/g, "").trim()
  const body = raw.length > MAX_BODY_CHARS ? `${raw.slice(0, MAX_BODY_CHARS)}\n[truncated]` : raw
  const kind = comment.isBot ? "bot" : comment.isLocal ? "local account, unprefixed: a human instruction" : "human"
  const quoted = (body.length > 0 ? body : "(no text)").replace(/^/gm, "> ")
  return `**${comment.author}** (${kind}, ${comment.createdAt}):\n${quoted}`
}

export async function fetchFeedback({
  runGh,
  target,
  ignoreTag,
  selfLogin,
}: {
  runGh: GhRunner
  target: Target
  ignoreTag: string | undefined
  selfLogin: string | undefined
}): Promise<string> {
  const payload = await fetchPrPayload({ runGh, target })
  const snapshot = normalizeSnapshot(payload, { ignoreTag, selfLogin })
  const bodies = collectBodies(payload)
  const sections: string[] = []

  for (const thread of snapshot.reviewThreads) {
    if (channelIsAcknowledged(thread.comments)) continue
    const location = thread.path === undefined ? "" : ` on ${thread.path}${thread.line === undefined ? "" : `:${thread.line}`}`
    const state = thread.isResolved ? "resolved" : "unresolved"
    const allBots = thread.comments.every((comment) => comment.isAgentReply || comment.isBot)
    sections.push(
      `### Thread \`${thread.id}\`${location} (${state}${allBots ? ", bot-only" : ""})\n\n` +
        unanswered(thread.comments).map((comment) => renderComment(comment, bodies)).join("\n\n"),
    )
  }

  const unthreaded = [...snapshot.issueComments, ...snapshot.reviewSummaries]
  if (unthreaded.length > 0 && !channelIsAcknowledged(unthreaded)) {
    sections.push(
      "### PR comments and review summaries (reply without `thread`)\n\n" +
        unanswered(unthreaded).map((comment) => renderComment(comment, bodies)).join("\n\n"),
    )
  }

  const key = targetKey(target)
  if (sections.length === 0) return `No feedback on ${key} is awaiting a reply.`
  return (
    `Feedback on ${key} awaiting a reply (${sections.length} channel${sections.length === 1 ? "" : "s"}):\n\n` +
    sections.join("\n\n") +
    `\n\nAnswer each channel with pr_monitor(action: "reply", pr: "${key}", thread: "<thread id>", body: "...") ` +
    "or omit thread for a PR comment; the reply prefix is added for you. A non-actionable bot acknowledgement " +
    "needs no reply: use mark_ready instead."
  )
}

export async function postReply({
  runGh,
  target,
  thread,
  body,
  replyPrefix,
}: {
  runGh: GhRunner
  target: Target
  thread: string | undefined
  body: string
  replyPrefix: string
}): Promise<string> {
  const text = body.startsWith(replyPrefix) ? body : `${replyPrefix} ${body}`
  if (thread === undefined) {
    const url = await runGh([
      "api", `repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
      "-f", `body=${text}`, "--jq", ".html_url",
    ])
    return `Posted a PR comment on ${targetKey(target)}: ${url.trim()}`
  }
  const payload = parseGhPayload(await runGh([
    "api", "graphql",
    "-f", "query=mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(" +
      "input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { url } } }",
    "-f", `thread=${thread}`,
    "-f", `body=${text}`,
  ]))
  const url = (payload as any)?.data?.addPullRequestReviewThreadReply?.comment?.url
  if (typeof url !== "string") throw new Error(`GitHub did not confirm the reply to thread ${thread}.`)
  return `Replied on thread ${thread}: ${url}`
}
