import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { afterEach } from "node:test"
import { fileURLToPath } from "node:url"

import type { GhRunner } from "../core/github"
import { createPrMonitorPlugin, PLUGIN_ID, TOOL_NAME, UNLOAD_NOTICE } from "../opencode/plugin"
import { parseSkillMarkdown } from "../opencode/skill"

const SKILL_PATH = fileURLToPath(new URL("../skills/monitor-pr/SKILL.md", import.meta.url))

let originalXdgConfigHome: string | undefined
let originalAutoMerge: string | undefined
let directory = ""

test.beforeEach(async () => {
  originalXdgConfigHome = process.env["XDG_CONFIG_HOME"]
  originalAutoMerge = process.env["SESORI_PR_MONITOR_AUTO_MERGE"]
  directory = await mkdtemp(join(tmpdir(), "pr-monitor-opencode-test-"))
  process.env["XDG_CONFIG_HOME"] = join(directory, "config")
  process.env["SESORI_PR_MONITOR_AUTO_MERGE"] = "false"
})

test.afterEach(async () => {
  if (originalXdgConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"]
  else process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome
  if (originalAutoMerge === undefined) delete process.env["SESORI_PR_MONITOR_AUTO_MERGE"]
  else process.env["SESORI_PR_MONITOR_AUTO_MERGE"] = originalAutoMerge
  await rm(directory, { recursive: true, force: true })
})

const runGh: GhRunner = async (args) => {
  if (args[0] === "api" && args[1] === "user") return "sesori-bot\n"
  if (args[0] === "api" && args[1] === "graphql") {
    return JSON.stringify({
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
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            comments: { totalCount: 0, nodes: [] },
            labels: { nodes: [] },
          },
        },
      },
    })
  }
  throw new Error(`unexpected gh call: ${args.join(" ")}`)
}

type SessionInput = { sessionID: string; text: string; description?: string; resume?: boolean }
type RegisteredTool = {
  name: string
  options?: { codemode?: boolean }
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: unknown }>
}
type RegisteredSkill = { id: string; name: string; description: string; path: string; content: string }
type HostEvent = { type: string; data: { sessionID: string } }

// A fake Promise-API host covering exactly the context members the plugin uses.
function fakeHost() {
  const prompts: SessionInput[] = []
  const synthetics: SessionInput[] = []
  const tools: RegisteredTool[] = []
  const skills: RegisteredSkill[] = []
  let firstPrompt: () => void = () => {}
  const prompted = new Promise<void>((resolve) => (firstPrompt = resolve))
  const pending: HostEvent[] = []
  let wake: () => void = () => {}
  let pulls = 0
  let onPull: () => void = () => {}
  let onEnd: () => void = () => {}

  async function* subscribe({ signal }: { signal: AbortSignal }): AsyncGenerator<HostEvent> {
    signal.addEventListener("abort", () => wake())
    try {
      for (;;) {
        pulls += 1
        onPull()
        while (pending.length === 0 && !signal.aborted) await new Promise<void>((resolve) => (wake = resolve))
        const event = pending.shift()
        if (event === undefined) return
        yield event
      }
    } finally {
      onEnd()
    }
  }

  const context = {
    location: { directory, project: { directory } },
    session: {
      prompt: async (input: SessionInput) => {
        prompts.push(input)
        firstPrompt()
      },
      synthetic: async (input: SessionInput) => {
        synthetics.push(input)
      },
    },
    skill: { transform: async (callback: (editor: { add: (skill: RegisteredSkill) => void }) => void) => {
      callback({ add: (skill) => skills.push(skill) })
    } },
    tool: { transform: async (callback: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
      callback({ add: (tool) => tools.push(tool) })
    } },
    event: { subscribe },
  }

  // Resolves once the subscriber has finished handling every event emitted so far.
  const emit = async (event: HostEvent): Promise<void> => {
    const handled = new Promise<void>((resolve, reject) => {
      const target = pulls + 1
      onPull = () => {
        if (pulls >= target) resolve()
      }
      // A subscriber that stops (e.g. after a handler error) fails the test instead of hanging it.
      onEnd = () => reject(new Error("event subscription ended before handling the event"))
    })
    pending.push(event)
    wake()
    await handled
  }

  return { context, prompts, synthetics, tools, skills, prompted, emit }
}

// Cleanup also runs after a failed assertion so monitors and subscriptions never leak into later tests.
const pendingCleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of pendingCleanups.splice(0)) await cleanup()
})

async function setUp() {
  const host = fakeHost()
  const plugin = createPrMonitorPlugin({ runGh })
  const cleanup = await plugin.setup(host.context as never)
  assert.equal(plugin.id, PLUGIN_ID)
  assert.equal(typeof cleanup, "function")
  const tool = host.tools.find((entry) => entry.name === TOOL_NAME)
  assert.ok(tool)
  const run = async ({ sessionID, input }: { sessionID: string; input: unknown }) =>
    String((await tool.execute(input, { sessionID })).content)
  const close = async () => (typeof cleanup === "function" ? cleanup() : undefined)
  pendingCleanups.push(close)
  return { host, tool, run, cleanup: close }
}

test("OpenCode registers one direct pr_monitor tool and the packaged monitor-pr skill", async () => {
  const { host, cleanup } = await setUp()
  assert.equal(host.tools.length, 1)
  assert.equal(host.tools[0]?.options?.codemode, false, "pr_monitor is a direct tool")

  const expected = parseSkillMarkdown({ path: SKILL_PATH, text: await readFile(SKILL_PATH, "utf8") })
  assert.equal(host.skills.length, 1)
  assert.deepEqual({ ...host.skills[0] }, expected)
  assert.equal(expected.id, "monitor-pr")
  assert.equal(expected.name, "monitor-pr")
  assert.ok(expected.description.length > 0)
  assert.ok(!expected.content.startsWith("---"), "skill content excludes frontmatter")
  await cleanup()
})

test("OpenCode delivers reports as prompts and persists unload notices without a model turn", async () => {
  const { host, run, cleanup } = await setUp()
  const started = await run({ sessionID: "session-1", input: { action: "start", pr: "sesori/example#42" } })
  assert.match(started, /Started monitoring/)
  await host.prompted
  assert.equal(host.prompts.length, 1)
  assert.deepEqual(Object.keys(host.prompts[0] ?? {}).sort(), ["sessionID", "text"], "the session owns agent/model")
  assert.equal(host.prompts[0]?.sessionID, "session-1")
  assert.match(host.prompts[0]?.text ?? "", /^\[PR Monitor\] \[sesori\/example#42\]/)

  await cleanup()

  assert.equal(host.prompts.length, 1, "cleanup never waits on prompt admission")
  assert.equal(host.synthetics.length, 1)
  const notice = host.synthetics[0]
  assert.equal(notice?.sessionID, "session-1")
  assert.equal(notice?.resume, false)
  assert.equal(notice?.description, notice?.text)
  assert.ok(notice?.text.includes(UNLOAD_NOTICE))
})

test("OpenCode keeps monitors per session and silently stops them when the session is deleted", async () => {
  const { host, run, cleanup } = await setUp()
  await run({ sessionID: "session-1", input: { action: "start", pr: "sesori/example#42" } })
  await host.prompted
  assert.match(await run({ sessionID: "session-2", input: { action: "status" } }), /No active monitors/)

  await host.emit({ type: "session.deleted", data: { sessionID: "session-1" } })

  assert.match(await run({ sessionID: "session-1", input: { action: "status" } }), /No active monitors/)
  await cleanup()
  assert.equal(host.synthetics.length, 0, "a deleted session gets no stop notice")
  assert.equal(host.prompts.length, 1)
})

test("OpenCode rejects malformed tool input", async () => {
  const { run, cleanup } = await setUp()
  await assert.rejects(run({ sessionID: "session-1", input: { action: "nope" } }), /action must be one of/)
  await assert.rejects(run({ sessionID: "session-1", input: { action: "start", pr: 42 } }), /pr must be a string/)
  await cleanup()
})

test("parseSkillMarkdown reads plain and folded frontmatter scalars", () => {
  const skill = parseSkillMarkdown({
    path: "/skills/example/SKILL.md",
    text: "---\nname: 'example'\ndescription: >-\n  first line\n  second line\n---\n# Body\n",
  })
  assert.deepEqual(skill, {
    id: "example",
    name: "example",
    description: "first line second line",
    path: "/skills/example/SKILL.md",
    content: "# Body\n",
  })
  assert.throws(() => parseSkillMarkdown({ path: "/x/SKILL.md", text: "# no frontmatter" }), /no frontmatter/)
})
