import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

const hook = resolve("claude-code/hooks/drain-spool.mjs")

type HookInput = {
  hook_event_name: "PostToolUse" | "Stop" | "UserPromptSubmit"
  agent_id?: string
}

function runHook({ home, input }: { home: string; input: HookInput }): string {
  const result = spawnSync(process.execPath, [hook], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    input: JSON.stringify(input),
    timeout: 30_000,
  })
  if (result.error !== undefined) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test("Claude plugin root contains the exact tracked release payload", () => {
  const files = execFileSync("git", ["ls-files", "claude-code"], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .map((path) => path.replace(/^claude-code\//, ""))
  assert.deepEqual(files, [
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "commands/ready.md",
    "commands/status.md",
    "commands/unready.md",
    "commands/watch.md",
    "dist/mcp-server.mjs",
    "hooks/await-activity.mjs",
    "hooks/drain-spool.mjs",
    "hooks/hooks.json",
    "skills/monitor-pr/SKILL.md",
    "src/mcp-server.ts",
    "src/session-state.ts",
    "src/spool.ts",
  ])
})

test("Claude hook drains once, skips subagents, and arms only its exact waiter", async () => {
  const home = await mkdtemp(join(tmpdir(), "pr-monitor-claude-hook-"))
  const spool = join(home, ".claude", "pr-monitor", "spool", String(process.pid))
  try {
    await mkdir(spool, { recursive: true })

    const first = join(spool, "001.md")
    await writeFile(first, "[PR Monitor] first report")
    const delivered = JSON.parse(runHook({ home, input: { hook_event_name: "PostToolUse" } }))
    assert.equal(delivered.hookSpecificOutput.hookEventName, "PostToolUse")
    assert.equal(delivered.hookSpecificOutput.additionalContext, "[PR Monitor] first report")
    assert.equal(existsSync(first), false)
    assert.equal(runHook({ home, input: { hook_event_name: "PostToolUse" } }), "")

    const subagent = join(spool, "002.md")
    await writeFile(subagent, "[PR Monitor] main-session report")
    assert.equal(runHook({ home, input: { hook_event_name: "PostToolUse", agent_id: "agent-1" } }), "")
    assert.equal(existsSync(subagent), true)
    const mainDelivery = JSON.parse(runHook({ home, input: { hook_event_name: "UserPromptSubmit" } }))
    assert.equal(mainDelivery.hookSpecificOutput.additionalContext, "[PR Monitor] main-session report")
    assert.equal(existsSync(subagent), false)

    const terminal = join(spool, "003.md")
    await writeFile(terminal, "[PR Monitor] terminal report")
    const stopDelivery = JSON.parse(runHook({ home, input: { hook_event_name: "Stop" } }))
    assert.equal(stopDelivery.decision, "block")
    assert.match(stopDelivery.reason, /\[PR Monitor\] terminal report/)
    assert.equal(existsSync(terminal), false)

    const now = Date.now()
    await writeFile(
      join(spool, "session.json"),
      JSON.stringify({
        version: 1,
        keepAlive: true,
        expiresAtMs: now + 60_000,
        keepAliveUntilMs: now + 60_000,
        monitors: ["sesori/example#42"],
      }),
    )
    const keepAlive = JSON.parse(runHook({ home, input: { hook_event_name: "Stop" } }))
    assert.equal(keepAlive.decision, "block")
    assert.match(keepAlive.reason, /\[PR Monitor keep-alive\]/)
    assert.match(keepAlive.reason, /await-activity\.mjs' --session/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
