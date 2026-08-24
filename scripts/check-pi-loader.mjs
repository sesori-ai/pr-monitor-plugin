import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent"

const entry = resolve("pi/dist/index.js")
const agentDirectory = await mkdtemp(join(tmpdir(), "pr-monitor-pi-agent-"))
try {
  const result = await discoverAndLoadExtensions([entry], process.cwd(), agentDirectory)
  assert.deepEqual(result.errors, [])
  assert.equal(result.extensions.length, 1)
  const extension = result.extensions[0]
  assert.ok(extension)
  assert.deepEqual([...extension.tools.keys()], ["pr_monitor"])
  assert.equal(extension.handlers.get("session_shutdown")?.length, 1)
  assert.equal(extension.handlers.has("resources_discover"), false)
  console.log("Pi loader check passed: one tool, upstream lifecycle, manifest-owned skill discovery")
} finally {
  await rm(agentDirectory, { recursive: true, force: true })
}
