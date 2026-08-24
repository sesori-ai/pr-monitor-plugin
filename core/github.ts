// GitHub data layer: one GraphQL query per poll via `gh api graphql`, plus
// additional pages only when a PR has more than 100 review threads, normalized
// into a PrSnapshot. Comments authored by the authenticated gh user containing
// the configured ignore tag are invisible to the plugin.

import type { Target } from "./target"

export type CommentMeta = { id: string; author: string; isBot: boolean; createdAt: string }

export type ReviewThreadInfo = {
  id: string
  isResolved: boolean
  comments: CommentMeta[] // ignore-filtered
}

export type CheckInfo = { name: string; outcome: "pending" | "success" | "failure" }

export type ReviewInfo = { login: string; state: string; submittedAt: string }

export type PrSnapshot = {
  title: string
  url: string
  state: "OPEN" | "MERGED" | "CLOSED"
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  headSha: string
  checks: CheckInfo[] // empty = PR has no CI checks
  reviews: ReviewInfo[] // latest review per reviewer (submitted only)
  pendingReviewers: string[] // requested, not yet reviewed
  reviewThreads: ReviewThreadInfo[]
  issueCommentsTotal: number // totalCount minus ignored among fetched window
  issueComments: CommentMeta[] // ignore-filtered (last 100 fetched)
  labels: string[] // label names currently on the PR
}

export class PollError extends Error {
  readonly notFound: boolean
  constructor(message: string, opts?: { notFound?: boolean }) {
    super(message)
    this.notFound = opts?.notFound ?? false
  }
}

export type GhRunner = (args: string[]) => Promise<string>

const PR_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title url state mergeable headRefOid
      commits(last: 1) { nodes { commit { statusCheckRollup {
        contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        } }
      } } } }
      reviewRequests(first: 50) { nodes { requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { slug }
        ... on Bot { login }
      } } }
      latestReviews(first: 50) { nodes { author { login __typename } state submittedAt } }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved
          comments(last: 100) { nodes { id author { login __typename } body createdAt } }
        }
      }
      comments(last: 100) { totalCount nodes { id author { login __typename } body createdAt } }
      labels(first: 100) { nodes { name } }
    }
  }
}`

const REVIEW_THREADS_PAGE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved
          comments(last: 100) { nodes { id author { login __typename } body createdAt } }
        }
      }
    }
  }
}`

function parseGhPayload(stdout: string): any {
  try {
    return JSON.parse(stdout)
  } catch {
    throw new PollError("gh returned non-JSON output")
  }
}

export async function fetchPrSnapshot(input: {
  runGh: GhRunner
  target: Target
  ignoreTag: string | undefined
  selfLogin: string | undefined
}): Promise<PrSnapshot> {
  const payload = parseGhPayload(await input.runGh([
    "api", "graphql",
    "-f", `query=${PR_QUERY}`,
    "-F", `owner=${input.target.owner}`,
    "-F", `repo=${input.target.repo}`,
    "-F", `number=${input.target.number}`,
  ]))
  const pr = payload?.data?.repository?.pullRequest
  if (!pr) return normalizeSnapshot(payload, { ignoreTag: input.ignoreTag, selfLogin: input.selfLogin })

  const threads = (pr.reviewThreads ??= { nodes: [] })
  threads.nodes ??= []
  const seenCursors = new Set<string>()
  while (threads.pageInfo?.hasNextPage) {
    const cursor = threads.pageInfo.endCursor
    if (typeof cursor !== "string" || seenCursors.has(cursor)) {
      throw new PollError("GitHub returned an invalid review-thread pagination cursor")
    }
    seenCursors.add(cursor)
    const page = parseGhPayload(await input.runGh([
      "api", "graphql",
      "-f", `query=${REVIEW_THREADS_PAGE_QUERY}`,
      "-F", `owner=${input.target.owner}`,
      "-F", `repo=${input.target.repo}`,
      "-F", `number=${input.target.number}`,
      "-f", `cursor=${cursor}`,
    ]))
    const next = page?.data?.repository?.pullRequest?.reviewThreads
    if (!next) throw new PollError("PR not found while fetching review threads", { notFound: true })
    threads.nodes.push(...(next.nodes ?? []))
    threads.pageInfo = next.pageInfo
  }
  return normalizeSnapshot(payload, { ignoreTag: input.ignoreTag, selfLogin: input.selfLogin })
}

type RawComment = { id: string; author: { login: string; __typename: string } | null; body: string; createdAt: string }

function toMeta(raw: RawComment): CommentMeta {
  return {
    id: raw.id,
    author: raw.author?.login ?? "ghost",
    isBot: raw.author?.__typename === "Bot",
    createdAt: raw.createdAt,
  }
}

export function normalizeSnapshot(
  payload: unknown,
  opts: { ignoreTag: string | undefined; selfLogin: string | undefined },
): PrSnapshot {
  const pr = (payload as any)?.data?.repository?.pullRequest
  if (!pr) throw new PollError("PR not found in GraphQL response", { notFound: true })

  const ignored = (raw: RawComment): boolean =>
    opts.ignoreTag !== undefined &&
    opts.selfLogin !== undefined &&
    raw.author?.login === opts.selfLogin &&
    raw.body.includes(opts.ignoreTag)

  const checks: CheckInfo[] = []
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
  for (const ctx of contexts) {
    if (ctx.__typename === "CheckRun") {
      const outcome =
        ctx.status !== "COMPLETED"
          ? "pending"
          : ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(ctx.conclusion)
            ? "success"
            : "failure"
      checks.push({ name: ctx.name, outcome })
    } else if (ctx.__typename === "StatusContext") {
      const outcome = ctx.state === "SUCCESS" ? "success" : ["PENDING", "EXPECTED"].includes(ctx.state) ? "pending" : "failure"
      checks.push({ name: ctx.context, outcome })
    }
  }

  const reviews: ReviewInfo[] = (pr.latestReviews?.nodes ?? [])
    .filter((node: any) => node.author?.login && node.state !== "PENDING")
    .map((node: any) => ({ login: node.author.login, state: node.state, submittedAt: node.submittedAt ?? "" }))

  const pendingReviewers: string[] = (pr.reviewRequests?.nodes ?? [])
    .map((node: any) => node.requestedReviewer?.login ?? node.requestedReviewer?.slug)
    .filter((name: unknown): name is string => typeof name === "string")

  const threads = pr.reviewThreads?.nodes ?? []
  const reviewThreads: ReviewThreadInfo[] = threads.map((thread: any) => ({
    id: thread.id,
    isResolved: thread.isResolved,
    comments: (thread.comments?.nodes ?? [])
      .filter((comment: RawComment) => !ignored(comment))
      .map(toMeta),
  }))

  const issueNodes: RawComment[] = pr.comments?.nodes ?? []
  const issueVisible = issueNodes.filter((node) => !ignored(node))
  const ignoredCount = issueNodes.length - issueVisible.length

  return {
    title: pr.title,
    url: pr.url,
    state: pr.state,
    mergeable: pr.mergeable ?? "UNKNOWN",
    headSha: pr.headRefOid,
    checks,
    reviews,
    pendingReviewers,
    reviewThreads,
    issueCommentsTotal: Math.max((pr.comments?.totalCount ?? issueNodes.length) - ignoredCount, 0),
    issueComments: issueVisible.map(toMeta),
    labels: (pr.labels?.nodes ?? [])
      .map((node: any) => node?.name)
      .filter((name: unknown): name is string => typeof name === "string"),
  }
}

export type CiPhase = "none" | "running" | "concluded"

export function ciPhase(snapshot: PrSnapshot): CiPhase {
  if (snapshot.checks.length === 0) return "none"
  return snapshot.checks.some((check) => check.outcome === "pending") ? "running" : "concluded"
}
