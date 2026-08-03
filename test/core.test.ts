import assert from "node:assert/strict"
import test from "node:test"

import { detectActivity, hasNewMergeConflict } from "../core/activity"
import { loadConfig, type MonitorConfig } from "../core/config"
import { fetchPrSnapshot, normalizeSnapshot, type CommentMeta, type PrSnapshot, type ReviewThreadInfo } from "../core/github"
import { buildReport } from "../core/report"
import type { Target } from "../core/target"
import { PrWatch } from "../core/watch"

const target: Target = { owner: "sesori", repo: "example", number: 42 }

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    title: "test PR",
    url: "https://github.com/sesori/example/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    headSha: "head-1",
    checks: [],
    reviews: [],
    pendingReviewers: [],
    reviewThreads: [],
    issueCommentsTotal: 0,
    issueComments: [],
    labels: [],
    ...overrides,
  }
}

function thread(
  id: string,
  isResolved: boolean,
  comments: Array<{ author: string; createdAt: string; isBot?: boolean }>,
): ReviewThreadInfo {
  return {
    id,
    isResolved,
    comments: comments.map((comment, index) => ({ id: `${id}-comment-${index + 1}`, isBot: false, ...comment })),
  }
}

function config(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    debounceMinutes: 2,
    maxCiWaitMinutes: 30,
    pollIntervalSeconds: 60,
    ignoreCommentTag: undefined,
    announceOnStart: true,
    flushOnCiFailure: true,
    desktopNotifications: false,
    readyLabel: "ready-for-human-review",
    keepAlive: true,
    keepAliveMaxMinutes: 120,
    ...overrides,
  }
}

function watchHarness(
  initial: PrSnapshot,
  polled: PrSnapshot[],
  cfg: MonitorConfig = config({ announceOnStart: false }),
  opts: { deliveryFailures?: number } = {},
) {
  let now = Date.parse("2026-08-03T12:00:00Z")
  let index = 0
  let remainingDeliveryFailures = opts.deliveryFailures ?? 0
  let deliveryAttempts = 0
  const reports: string[] = []
  const watch = new PrWatch({
    target,
    sessionID: "session-1",
    config: cfg,
    initial,
    deps: {
      now: () => now,
      fetchSnapshot: async () => polled[Math.min(index++, polled.length - 1)]!,
      deliver: async (report) => {
        deliveryAttempts += 1
        if (remainingDeliveryFailures > 0) {
          remainingDeliveryFailures -= 1
          throw new Error("delivery failed")
        }
        reports.push(report)
      },
      log: () => {},
      onStopped: () => {},
    },
  })
  return {
    watch,
    reports,
    get deliveryAttempts() {
      return deliveryAttempts
    },
    advance(ms: number) {
      now += ms
    },
  }
}

test("the default debounce is two minutes", async () => {
  const loaded = await loadConfig([], () => {})
  assert.equal(loaded.debounceMinutes, 2)
})

test("a failed initial announcement retries all startup comments", async () => {
  const initial = snapshot({
    reviewThreads: [thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T11:00:00Z" }])],
  })
  const harness = watchHarness(initial, [initial], config(), { deliveryFailures: 1 })

  assert.equal(await harness.watch.announceInitial(), false)
  assert.equal(harness.deliveryAttempts, 1)
  assert.equal(harness.reports.length, 0)

  await harness.watch.tick()
  assert.equal(harness.deliveryAttempts, 2)
  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /1 thread received 1 new comment since last flush/)
})

test("normalization preserves review-thread state and filters tagged self replies", () => {
  const payload = {
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: {
            nodes: [
              {
                id: "thread-1",
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      id: "comment-1",
                      author: { login: "reviewer", __typename: "User" },
                      body: "Please reconsider this.",
                      createdAt: "2026-08-03T11:00:00Z",
                    },
                    {
                      id: "comment-2",
                      author: { login: "owner", __typename: "User" },
                      body: "[Sesori reply] I do not think this is needed.",
                      createdAt: "2026-08-03T11:05:00Z",
                    },
                    {
                      id: "comment-3",
                      author: { login: "owner", __typename: "User" },
                      body: "Please still address the edge case.",
                      createdAt: "2026-08-03T11:10:00Z",
                    },
                  ],
                },
              },
              {
                id: "thread-2",
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      id: "comment-4",
                      author: { login: "alice", __typename: "User" },
                      body: "Follow-up on the resolved thread.",
                      createdAt: "2026-08-03T11:15:00Z",
                    },
                  ],
                },
              },
            ],
          },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  }

  const result = normalizeSnapshot(payload, { ignoreTag: "[Sesori reply]", selfLogin: "owner" })

  assert.deepEqual(
    result.reviewThreads.map((item) => ({
      id: item.id,
      isResolved: item.isResolved,
      authors: item.comments.map((comment) => comment.author),
    })),
    [
      { id: "thread-1", isResolved: false, authors: ["reviewer", "owner"] },
      { id: "thread-2", isResolved: true, authors: ["alice"] },
    ],
  )
})

test("fetching a snapshot paginates review threads", async () => {
  const payload = {
    data: {
      repository: {
        pullRequest: {
          title: "test PR",
          url: "https://github.com/sesori/example/pull/42",
          state: "OPEN",
          mergeable: "MERGEABLE",
          headRefOid: "head-1",
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            nodes: [
              {
                id: "thread-1",
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      id: "comment-1",
                      author: { login: "reviewer", __typename: "User" },
                      body: "First page",
                      createdAt: "2026-08-03T11:00:00Z",
                    },
                  ],
                },
              },
            ],
          },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  }
  const secondPage = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "thread-2",
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      id: "comment-2",
                      author: { login: "alice", __typename: "User" },
                      body: "Second page",
                      createdAt: "2026-08-03T11:05:00Z",
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  }
  const calls: string[][] = []
  const result = await fetchPrSnapshot({
    target,
    ignoreTag: undefined,
    selfLogin: undefined,
    runGh: async (args) => {
      calls.push(args)
      return JSON.stringify(calls.length === 1 ? payload : secondPage)
    },
  })

  assert.deepEqual(result.reviewThreads.map((item) => item.id), ["thread-1", "thread-2"])
  assert.equal(calls.length, 2)
  assert.ok(calls[1]?.includes("cursor=cursor-1"))
})

test("a follow-up in an existing thread is activity even when resolution counts do not change", () => {
  const before = snapshot({
    reviewThreads: [
      thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T11:00:00Z" }]),
    ],
  })
  const after = snapshot({
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
        { author: "owner", createdAt: "2026-08-03T11:10:00Z" },
      ]),
    ],
  })

  assert.equal(detectActivity(before, after, "MERGEABLE"), true)
})

test("an ignored reply rolling a full comment window does not look like visible activity", () => {
  const visible = Array.from({ length: 100 }, (_, index): CommentMeta => ({
    id: `comment-${index + 1}`,
    author: "reviewer",
    isBot: false,
    createdAt: `2026-08-03T11:${String(index % 60).padStart(2, "0")}:00Z`,
  }))
  const before = snapshot({ reviewThreads: [{ id: "thread-1", isResolved: false, comments: visible }] })
  const afterIgnoredReply = snapshot({
    reviewThreads: [{ id: "thread-1", isResolved: false, comments: visible.slice(1) }],
  })
  const afterHumanReply = snapshot({
    reviewThreads: [
      {
        id: "thread-1",
        isResolved: false,
        comments: [
          ...visible.slice(1),
          { id: "comment-101", author: "owner", isBot: false, createdAt: "2026-08-03T12:01:00Z" },
        ],
      },
    ],
  })

  assert.equal(detectActivity(before, afterIgnoredReply, "MERGEABLE"), false)
  assert.equal(detectActivity(before, afterHumanReply, "MERGEABLE"), true)
})

test("reports identify resolved and unresolved threads that received new comments", () => {
  const report = buildReport(
    target,
    snapshot({
      reviewThreads: [
        thread("thread-1", false, [
          { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
          { author: "alice", createdAt: "2026-08-03T12:01:00Z" },
        ]),
        thread("thread-2", true, [{ author: "owner", createdAt: "2026-08-03T12:02:00Z" }]),
        thread("thread-3", false, [{ author: "reviewer", createdAt: "2026-08-03T11:30:00Z" }]),
      ],
    }),
    { baselineMs: Date.parse("2026-08-03T12:00:00Z") },
  )

  assert.match(
    report,
    /\[comment:inline\] 2 unresolved threads; 2 threads received 2 new comments since last flush \(1 currently unresolved, 1 currently resolved; 1 alice, 1 owner\)/,
  )
})

test("report baselines use comment IDs when GitHub timestamps share a second", () => {
  const before = snapshot({
    reviewThreads: [thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T12:00:00Z" }])],
  })
  const after = snapshot({
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T12:00:00Z" },
        { author: "owner", createdAt: "2026-08-03T12:00:00Z" },
      ]),
    ],
  })

  const report = buildReport(target, after, {
    baselineMs: Date.parse("2026-08-03T12:00:00.900Z"),
    baselineSnapshot: before,
  })

  assert.match(report, /1 thread received 1 new comment since last flush/)
})

test("new merge conflicts are recognized across transient UNKNOWN polls", () => {
  assert.equal(hasNewMergeConflict("MERGEABLE", snapshot({ mergeable: "CONFLICTING" })), true)
  assert.equal(hasNewMergeConflict("CONFLICTING", snapshot({ mergeable: "CONFLICTING" })), false)
  assert.equal(hasNewMergeConflict(undefined, snapshot({ mergeable: "CONFLICTING" })), true)
})

test("a MERGEABLE to UNKNOWN to CONFLICTING sequence flushes when it settles", async () => {
  const initial = snapshot({ mergeable: "MERGEABLE" })
  const unknown = snapshot({ mergeable: "UNKNOWN" })
  const conflicting = snapshot({ mergeable: "CONFLICTING" })
  const harness = watchHarness(initial, [unknown, conflicting])

  await harness.watch.tick()
  assert.equal(harness.reports.length, 0)
  await harness.watch.tick()
  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /Mergeable: CONFLICTING/)
})

test("a new merge conflict bypasses debounce and a running-CI hold", async () => {
  const initial = snapshot({ checks: [{ name: "tests", outcome: "pending" }] })
  const next = snapshot({
    mergeable: "CONFLICTING",
    checks: [{ name: "tests", outcome: "pending" }],
  })
  const harness = watchHarness(initial, [next])

  await harness.watch.tick()

  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /Mergeable: CONFLICTING/)
})

test("merge and close transitions bypass debounce", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const harness = watchHarness(snapshot(), [snapshot({ state })])
    await harness.watch.tick()
    assert.equal(harness.reports.length, 1)
    assert.equal(harness.watch.isStopped, true)
  }
})

test("a newly failing check still bypasses debounce", async () => {
  const initial = snapshot({ checks: [{ name: "lint", outcome: "pending" }] })
  const next = snapshot({ checks: [{ name: "lint", outcome: "failure" }] })
  const harness = watchHarness(initial, [next])

  await harness.watch.tick()

  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /CI: failing/)
})

test("failed urgent delivery retries immediately", async () => {
  const initial = snapshot({
    reviewThreads: [thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T11:00:00Z" }])],
  })
  const conflicting = snapshot({
    mergeable: "CONFLICTING",
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
        { author: "owner", createdAt: "2026-08-03T12:00:01Z" },
      ]),
    ],
  })
  const harness = watchHarness(initial, [conflicting, conflicting], config({ announceOnStart: false }), {
    deliveryFailures: 1,
  })

  await harness.watch.tick()
  assert.equal(harness.deliveryAttempts, 1)
  assert.equal(harness.reports.length, 0)

  await harness.watch.tick()
  assert.equal(harness.deliveryAttempts, 2)
  assert.equal(harness.reports.length, 1)
  assert.match(harness.reports[0]!, /1 thread received 1 new comment since last flush/)
})

test("ordinary activity waits for the two-minute quiet window", async () => {
  const initial = snapshot({
    reviewThreads: [thread("thread-1", false, [{ author: "reviewer", createdAt: "2026-08-03T11:00:00Z" }])],
  })
  const changed = snapshot({
    reviewThreads: [
      thread("thread-1", false, [
        { author: "reviewer", createdAt: "2026-08-03T11:00:00Z" },
        { author: "alice", createdAt: "2026-08-03T12:00:01Z" },
      ]),
    ],
  })
  const harness = watchHarness(initial, [changed, changed, changed])

  await harness.watch.tick()
  harness.advance(2 * 60_000 - 1)
  await harness.watch.tick()
  assert.equal(harness.reports.length, 0)

  harness.advance(1)
  await harness.watch.tick()
  assert.equal(harness.reports.length, 1)
})
