import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  loadClaudeConfig,
  loadMonitorConfig,
  type MonitorConfig,
} from "../core/config"
import type { GhRunner, PrSnapshot } from "../core/github"
import {
  InitialAnnouncementMode,
  MonitorSession,
  StopNoticeChannel,
  type ReportChannel,
} from "../runtime/monitor-session"
import { buildMonitorToolDescription, MonitorAction } from "../runtime/tool"

function config(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    debounceMinutes: 2,
    maxCiWaitMinutes: 30,
    pollIntervalSeconds: 60,
    ignoreCommentTag: undefined,
    announceOnStart: false,
    flushOnCiFailure: true,
    readyLabel: "ready-for-human-review",
    ...overrides,
  }
}

function payload({ number = 42, state = "OPEN" }: { number?: number; state?: PrSnapshot["state"] } = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          title: `test PR ${number}`,
          url: `https://github.com/sesori/example/pull/${number}`,
          state,
          mergeable: "MERGEABLE",
          headRefOid: `head-${number}`,
          commits: { nodes: [] },
          reviewRequests: { nodes: [] },
          latestReviews: { nodes: [] },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          labels: { nodes: [] },
        },
      },
    },
  })
}

type RunnerState = {
  calls: string[][]
  userCalls: number
  failLabelAdd: boolean
  labelAdded: boolean
}

function runnerHarness(): { runGh: GhRunner; state: RunnerState } {
  const state: RunnerState = { calls: [], userCalls: 0, failLabelAdd: false, labelAdded: false }
  const runGh: GhRunner = async (args) => {
    state.calls.push(args)
    if (args[0] === "api" && args[1] === "user") {
      state.userCalls += 1
      return "sesori-bot\n"
    }
    if (args[0] === "api" && args[1] === "graphql") {
      const rawNumber = args.find((arg) => arg.startsWith("number="))?.slice("number=".length)
      return payload({ number: Number(rawNumber ?? 42) })
    }
    const route = args.find((arg) => arg.startsWith("repos/")) ?? ""
    if (route.includes("/pulls/")) return JSON.stringify({ state: "open", merged: false })
    if (/\/labels$/.test(route) && !route.includes("/issues/")) throw new Error("label already exists")
    if (route.includes("/issues/") && args.includes("DELETE")) {
      state.labelAdded = false
      return ""
    }
    if (route.includes("/issues/")) {
      if (state.failLabelAdd) throw new Error("label add failed")
      state.labelAdded = true
      return ""
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  }
  return { runGh, state }
}

type FakeTimer = { callback: () => void; cancelled: boolean }

function timerHarness(): {
  timers: FakeTimer[]
  schedule: (input: { callback: () => void; intervalMs: number }) => FakeTimer
  cancel: (input: { timer: unknown }) => void
} {
  const timers: FakeTimer[] = []
  return {
    timers,
    schedule: ({ callback }) => {
      const timer = { callback, cancelled: false }
      timers.push(timer)
      return timer
    },
    cancel: ({ timer }) => {
      const fakeTimer = timer as FakeTimer
      fakeTimer.cancelled = true
    },
  }
}

function channelHarness(): { channel: ReportChannel; delivered: string[]; persisted: string[] } {
  const delivered: string[] = []
  const persisted: string[] = []
  return {
    delivered,
    persisted,
    channel: {
      deliver: async ({ report }) => {
        delivered.push(report)
      },
      persist: async ({ report }) => {
        persisted.push(report)
      },
    },
  }
}

function startOptions({ channel }: { channel: ReportChannel }) {
  return {
    announcementMode: InitialAnnouncementMode.awaitDelivery,
    createChannel: () => channel,
  }
}

test("common and Claude config resolve separate settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pr-monitor-config-"))
  const path = join(directory, "pr-monitor.json")
  await writeFile(
    path,
    JSON.stringify({
      debounceMinutes: 5,
      readyLabel: "ready",
      desktopNotifications: true,
      keepAlive: false,
      keepAliveMaxMinutes: 9,
    }),
  )
  try {
    const common = await loadMonitorConfig({ paths: [path], log: () => {} })
    const claude = await loadClaudeConfig({ paths: [path], log: () => {} })
    assert.equal(common.debounceMinutes, 5)
    assert.equal(common.readyLabel, "ready")
    assert.equal("desktopNotifications" in common, false)
    assert.equal(claude.desktopNotifications, true)
    assert.equal(claude.keepAlive, false)
    assert.equal(claude.keepAliveMaxMinutes, 9)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("concurrent starts deduplicate after fetch and share authenticated identity", async () => {
  const runner = runnerHarness()
  const timers = timerHarness()
  const channel = channelHarness()
  const session = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config({ ignoreCommentTag: "[Sesori reply]" }),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  const [first, second] = await Promise.all([
    session.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) }),
    session.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) }),
  ])

  assert.equal([first, second].filter((result) => result.start !== undefined).length, 1)
  assert.equal([first.text, second.text].filter((text) => text.startsWith("Already monitoring")).length, 1)
  assert.equal(runner.state.userCalls, 1)
  assert.equal(timers.timers.length, 1)
  assert.equal(session.list().length, 1)
  await session.stopAll({})
})

test("sessions isolate targets and stale timers cannot remove a successor watch", async () => {
  const runner = runnerHarness()
  const firstTimers = timerHarness()
  const secondTimers = timerHarness()
  const channel = channelHarness()
  const first = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: firstTimers.schedule,
    cancel: firstTimers.cancel,
  })
  const second = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: secondTimers.schedule,
    cancel: secondTimers.cancel,
  })

  await first.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) })
  await second.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) })
  const caseVariant = await first.execute({
    action: MonitorAction.start,
    pr: "SESORI/Example#42",
    start: startOptions(channel),
  })
  assert.match(caseVariant.text, /Already monitoring/)
  assert.equal(firstTimers.timers.length, 1)
  const staleTimer = firstTimers.timers[0]!
  await first.execute({ action: MonitorAction.stop, pr: "SESORI/Example#42" })
  await first.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) })

  staleTimer.callback()
  await Promise.resolve()
  assert.equal(first.list().length, 1)
  assert.equal(second.list().length, 1)
  assert.equal(staleTimer.cancelled, true)
  await Promise.all([first.stopAll({}), second.stopAll({})])
})

test("lifecycle cleanup invalidates a start that is still loading", async () => {
  const runner = runnerHarness()
  const timers = timerHarness()
  const channel = channelHarness()
  let resolveConfig!: (value: MonitorConfig) => void
  const configPending = new Promise<MonitorConfig>((resolve) => {
    resolveConfig = resolve
  })
  const session = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: () => configPending,
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  const starting = session.execute({
    action: MonitorAction.start,
    pr: "sesori/example#42",
    start: startOptions(channel),
  })
  await Promise.resolve()
  await session.stopAll({})
  resolveConfig(config())

  const result = await starting
  assert.match(result.text, /session ended while .* was starting/)
  assert.equal(session.list().length, 0)
  assert.equal(timers.timers.length, 0)
})

test("persistent shutdown notices use the persistent channel and clear every timer", async () => {
  const runner = runnerHarness()
  const timers = timerHarness()
  const channels = new Map<number, ReturnType<typeof channelHarness>>()
  const session = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
  })

  for (const number of [42, 43]) {
    const harness = channelHarness()
    channels.set(number, harness)
    await session.execute({
      action: MonitorAction.start,
      pr: `sesori/example#${number}`,
      start: startOptions(harness),
    })
  }
  await session.stopAll({ notice: "Monitor stopped for test.", channel: StopNoticeChannel.persistent })

  assert.equal(session.list().length, 0)
  assert.equal(timers.timers.every((timer) => timer.cancelled), true)
  for (const harness of channels.values()) {
    assert.equal(harness.delivered.length, 0)
    assert.equal(harness.persisted.length, 1)
    assert.match(harness.persisted[0]!, /Monitor stopped for test/)
  }
})

test("ready handoff happens only after GitHub accepts the label", async () => {
  const runner = runnerHarness()
  const timers = timerHarness()
  const channel = channelHarness()
  let handedOff = false
  const readyEvents: boolean[] = []
  const session = new MonitorSession({
    runGh: runner.runGh,
    loadConfig: async () => config(),
    log: () => {},
    schedule: timers.schedule,
    cancel: timers.cancel,
    onReadyChanged: ({ ready, watched }) => {
      assert.equal(runner.state.labelAdded, ready)
      readyEvents.push(ready)
      handedOff = ready && watched
    },
    statusSuffix: () => (handedOff ? ", handed off for human review" : ""),
  })
  await session.execute({ action: MonitorAction.start, pr: "sesori/example#42", start: startOptions(channel) })

  runner.state.failLabelAdd = true
  const failed = await session.execute({ action: MonitorAction.markReady, pr: "sesori/example#42" })
  assert.match(failed.text, /Cannot mark/)
  assert.deepEqual(readyEvents, [])
  assert.equal(handedOff, false)

  runner.state.failLabelAdd = false
  const ready = await session.execute({ action: MonitorAction.markReady, pr: "sesori/example#42" })
  assert.match(ready.text, /label "ready-for-human-review" added/)
  assert.deepEqual(readyEvents, [true])
  const status = await session.execute({ action: MonitorAction.status, pr: undefined })
  assert.match(status.text, /handed off for human review/)

  const unready = await session.execute({ action: MonitorAction.unmarkReady, pr: "sesori/example#42" })
  assert.match(unready.text, /no longer flagged for human review/)
  assert.deepEqual(readyEvents, [true, false])
  assert.equal(handedOff, false)
  await session.stopAll({})
})

test("tool wording makes autonomous delivery and the no-delay rule explicit", () => {
  const description = buildMonitorToolDescription({
    delivery: "reports arrive here.",
    configPath: ".pr-monitor.json",
    lifecycle: "Session scoped.",
    waiting: "End the turn while idle.",
  })
  assert.match(description, /notifications arrive automatically/)
  assert.match(description, /NEVER create sleeps/)
  assert.match(description, /routine status\/flush/)
  assert.match(description, /when flushOnCiFailure is enabled/)
  assert.match(description, /configured ready label/)
})
