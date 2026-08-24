import assert from "node:assert/strict"
import { resolve } from "node:path"

const loaderModule = process.env["OMP_LOADER_MODULE"]
if (!loaderModule) throw new Error("OMP_LOADER_MODULE is required")
const { loadExtensions } = await import(loaderModule)
const entry = resolve("pi/dist/omp.js")
const result = await loadExtensions([entry], process.cwd())
assert.deepEqual(result.errors, [])
assert.equal(result.extensions.length, 1)
const extension = result.extensions[0]
assert.ok(extension)
assert.deepEqual([...extension.tools.keys()], ["pr_monitor"])
const monitorTool = extension.tools.get("pr_monitor")
assert.ok(monitorTool)
assert.match(monitorTool.definition.description, /\.omp\/pr-monitor\.json/)
assert.doesNotMatch(monitorTool.definition.description, /\.pi\/pr-monitor\.json/)
assert.equal(extension.handlers.get("session_shutdown")?.length, 1)
assert.equal(extension.handlers.get("session_switch")?.length, 1)
const resourceHandlers = extension.handlers.get("resources_discover") ?? []
assert.equal(resourceHandlers.length, 1)
const resources = await resourceHandlers[0]({ type: "resources_discover", cwd: process.cwd(), reason: "startup" }, {})
assert.deepEqual(resources?.skillPaths, [resolve("pi/skills")])
console.log("OMP loader check passed: one tool, switch cleanup, and one discovered skill path")
