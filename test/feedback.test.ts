import assert from "node:assert/strict"
import test from "node:test"

import type { MonitorConfig } from "../core/config"
import type { GhRunner } from "../core/github"
import { MonitorSession } from "../runtime/monitor-session"
import { MonitorAction } from "../runtime/tool"

const PREFIX = "[agent]"

function config(): MonitorConfig {
  return {
    debounceMinutes: 2,
    maxCiWaitMinutes: 30,
    pollIntervalSeconds: 60,
    ignoreCommentTag: PREFIX,
    announceOnStart: false,
    flushOnCiFailure: true,
    readyLabel: "agent-ready",
    autoMerge: false,
  }
}

const bot = { login: "reviewer[bot]", __typename: "Bot" }
const self = { login: "me", __typename: "User" }
const human = { login: "alice", __typename: "User" }

function comment(id: string, author: object, body: string, minute: number) {
  return { id, author, body, createdAt: `2026-10-27T10:${String(minute).padStart(2, "0")}:00Z` }
}

function payload(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          title: "PR",
          url: "https://github.com/o/r/pull/7",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: {
            nodes: [{ id: "rev1", author: bot, state: "COMMENTED", submittedAt: "2026-10-27T10:05:00Z", body: "Summary" }],
          },
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "PRRT_open",
                isResolved: false,
                path: "a.ts",
                line: 3,
                comments: {
                  nodes: [
                    comment("c1", bot, "<!-- meta -->Old finding", 1),
                    comment("c2", self, `${PREFIX} Addressed`, 2),
                    comment("c3", bot, "<!-- meta -->New finding", 3),
                  ],
                },
              },
              {
                id: "PRRT_done",
                isResolved: true,
                path: "b.ts",
                comments: { nodes: [comment("c4", human, "Rename this", 1), comment("c5", self, `${PREFIX} Done`, 2)] },
              },
            ],
          },
          comments: { totalCount: 1, nodes: [comment("i1", self, "please also fix the docs", 4)] },
          labels: { nodes: [] },
        },
      },
    },
  })
}

function harness(): { runGh: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  const runGh: GhRunner = async (args) => {
    calls.push(args)
    if (args[1] === "user") return "me\n"
    if (args[1] === "graphql" && args.some((arg) => arg.includes("addPullRequestReviewThreadReply"))) {
      return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { url: "https://x/thread-reply" } } } })
    }
    if (args[1] === "graphql") return payload()
    if (args[1]?.endsWith("/issues/7/comments")) return "https://x/issue-comment\n"
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  return { runGh, calls }
}

function session(runGh: GhRunner) {
  return new MonitorSession<MonitorConfig>({ runGh, log: () => {}, loadConfig: async () => config() })
}

test("feedback returns only unanswered comments with bodies", async () => {
  const { runGh } = harness()
  const { text } = await session(runGh).execute({ action: MonitorAction.feedback, pr: "o/r#7" })

  assert.match(text, /awaiting a reply \(2 channels\)/)
  assert.match(text, /Thread `PRRT_open` on a\.ts:3 \(unresolved, bot-only\)/)
  assert.match(text, /> New finding/)
  assert.doesNotMatch(text, /Old finding|meta|PRRT_done|Rename this/)
  // The unprefixed local comment is a human instruction, and the later bot summary still needs an answer.
  assert.match(text, /\*\*me\*\* \(local account, unprefixed: a human instruction/)
  assert.match(text, /> Summary/)
})

test("reply prefixes thread replies once and posts PR comments without a thread", async () => {
  const { runGh, calls } = harness()
  const monitor = session(runGh)

  const threaded = await monitor.execute({ action: MonitorAction.reply, pr: "o/r#7", thread: "PRRT_open", body: "Fixed in abc" })
  assert.equal(threaded.text, "Replied on thread PRRT_open: https://x/thread-reply")
  assert.ok(calls.at(-1)?.includes(`body=${PREFIX} Fixed in abc`))
  assert.ok(calls.at(-1)?.includes("thread=PRRT_open"))

  const comment = await monitor.execute({ action: MonitorAction.reply, pr: "o/r#7", body: `${PREFIX} Docs updated` })
  assert.equal(comment.text, "Posted a PR comment on o/r#7: https://x/issue-comment")
  assert.ok(calls.at(-1)?.includes(`body=${PREFIX} Docs updated`))

  const empty = await monitor.execute({ action: MonitorAction.reply, pr: "o/r#7", body: "  " })
  assert.equal(empty.text, "action 'reply' requires a non-empty body.")
})
