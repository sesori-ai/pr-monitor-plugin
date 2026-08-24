import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ompCli = process.env["OMP_CLI"]
if (!ompCli) throw new Error("OMP_CLI is required")
const bun = process.env["BUN_BIN"] ?? (process.platform === "win32" ? "bun.exe" : "bun")
const home = await mkdtemp(join(tmpdir(), "pr-monitor-omp-home-"))
try {
  const result = spawnSync(
    bun,
    [ompCli, "--mode", "rpc", "--no-session", "--model", "openai/gpt-5.2", "-e", "./pi"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: "",
      timeout: 60_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, OPENAI_API_KEY: "loader-check-only" },
    },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`OMP RPC package check failed: ${result.stderr}`)
  const rows = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  const commands = rows.find((row) => row.type === "available_commands_update")?.commands ?? []
  const skills = commands.filter(
    (command) => command.source === "skill" && command.name === "skill:monitor-pr",
  )
  assert.equal(skills.length, 1)
  console.log("OMP package check passed: RPC discovers exactly one monitor-pr skill")
} finally {
  await rm(home, { recursive: true, force: true })
}
