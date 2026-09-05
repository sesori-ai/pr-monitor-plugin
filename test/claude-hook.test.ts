import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"

const hook = resolve("claude-codex/hooks/drain-spool.mjs")

type HookInput = {
  hook_event_name: "PostToolUse" | "Stop" | "UserPromptSubmit"
  agent_id?: string
  tool_input?: unknown
  tool_response?: unknown
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
  const files = execFileSync("git", ["ls-files", "claude-codex"], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .map((path) => path.replace(/^claude-codex\//, ""))
  assert.deepEqual(files, [
    ".claude-plugin/plugin.json",
    ".codex-mcp.json",
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "commands/ready.md",
    "commands/status.md",
    "commands/unready.md",
    "commands/watch.md",
    "dist/mcp-server.mjs",
    "hooks/await-activity.mjs",
    "hooks/codex-hooks.json",
    "hooks/drain-spool.mjs",
    "hooks/hooks.json",
    "skills/monitor-pr/SKILL.md",
    "src/mcp-server.ts",
    "src/push.ts",
    "src/session-state.ts",
    "src/spool.ts",
  ])
})

test("Claude handoff follows readiness transitions rather than report delivery", async () => {
  const source = await readFile("claude-codex/src/mcp-server.ts", "utf8")

  assert.match(source, /onReadyChanged:.*if \(!ready\).*extendKeepAlive\(\{ config \}\)/s)
  // \r?\n: Windows checkouts read the source with CRLF endings.
  const deliverBody = /const deliver = async \(\{[\s\S]*?\r?\n  \}\r?\n/.exec(source)?.[0] ?? ""
  assert.ok(deliverBody.length > 0, "deliver body not found")
  assert.doesNotMatch(deliverBody, /handedOff\.delete/)
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
    assert.match(keepAlive.reason, /automatic readiness is waiting/)
    assert.match(keepAlive.reason, /non-actionable.*mark_ready/)
    assert.match(keepAlive.reason, /await-activity\.mjs' --session/)

    // Codex sandboxes the waiter away from the spool, so the hook stamps the
    // waiter proof itself when the finished tool call was the waiter.
    const waiterProof = join(spool, ".waiter")
    assert.equal(existsSync(waiterProof), false)
    const waiterCommand = { command: "node '/x/await-activity.mjs' --session 1" }
    runHook({ home, input: { hook_event_name: "PostToolUse", tool_input: { command: "ls" } } })
    assert.equal(existsSync(waiterProof), false)
    // A waiter that never ran (node missing, script unreadable) leaves no proof.
    runHook({
      home,
      input: { hook_event_name: "PostToolUse", tool_input: waiterCommand, tool_response: "node: command not found" },
    })
    assert.equal(existsSync(waiterProof), false)
    runHook({
      home,
      input: {
        hook_event_name: "PostToolUse",
        tool_input: waiterCommand,
        tool_response: { stdout: "pr-monitor: no PR activity in the last 9m." },
      },
    })
    assert.equal(existsSync(waiterProof), false)
    // The waiter's real final line is the only accepted proof.
    const waiterOutput = spawnSync(process.execPath, [resolve("claude-codex/hooks/await-activity.mjs")], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }).stdout
    assert.match(waiterOutput, /pr-monitor-waiter: done\s*$/)
    runHook({
      home,
      input: { hook_event_name: "PostToolUse", tool_input: waiterCommand, tool_response: { stdout: waiterOutput } },
    })
    assert.equal(existsSync(waiterProof), true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
