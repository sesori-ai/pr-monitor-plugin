import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const home = await mkdtemp(join(tmpdir(), "pr-monitor-pi-home-"))
const piCli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js")
try {
  const request = `${JSON.stringify({ id: "skills", type: "get_commands" })}\n`
  const result = spawnSync(process.execPath, [piCli, "--mode", "rpc", "--no-session", "-e", "./pi"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: request,
    timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`Pi RPC package check failed: ${result.stderr}`)
  const rows = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  const response = rows.find((row) => row.id === "skills")
  assert.equal(response?.success, true)
  const skills = response.data.commands.filter(
    (command) => command.source === "skill" && command.name === "skill:monitor-pr",
  )
  assert.equal(skills.length, 1)
  console.log("Pi package check passed: RPC discovers exactly one monitor-pr skill")
} finally {
  await rm(home, { recursive: true, force: true })
}
