import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { MONITOR_ACTION_VALUES } from "../runtime/tool"

test("Hermes Python adapter and packaged worker contracts", { timeout: 60000 }, () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-B", "test/hermes_adapter_test.py"], {
    encoding: "utf8",
    timeout: 55000,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: `${process.cwd()}/.test-no-global-config-${process.pid}`,
      SESORI_PR_MONITOR_AUTO_MERGE: "false",
    },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""))
})

test("Hermes packaged tool schema registers every shared action", async () => {
  const tool = JSON.parse(await readFile("hermes/dist/tool.json", "utf8")) as {
    parameters: { properties: { action: { enum: string[] } } }
  }
  assert.deepEqual(tool.parameters.properties.action.enum, [...MONITOR_ACTION_VALUES])
})
