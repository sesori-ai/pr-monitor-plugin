import { readFile } from "node:fs/promises"

const manifests = [
  ["OpenCode", new URL("../opencode/package.json", import.meta.url)],
  ["Claude Code", new URL("../claude-code/.claude-plugin/plugin.json", import.meta.url)],
]
const piManifest = new URL("../pi/package.json", import.meta.url)
try {
  await readFile(piManifest)
  manifests.push(["Pi/OMP", piManifest])
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  // The Pi workspace is introduced by the next planned step.
}

const versions = await Promise.all(
  manifests.map(async ([name, url]) => {
    const manifest = JSON.parse(await readFile(url, "utf8"))
    if (typeof manifest.version !== "string") throw new Error(`${name} manifest has no version`)
    return [name, manifest.version]
  }),
)
const expected = versions[0][1]
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"))
versions.push(["OpenCode lock", lock.packages?.opencode?.version])
const serverSource = await readFile(new URL("../claude-code/src/mcp-server.ts", import.meta.url), "utf8")
const serverVersion = /new McpServer\(\{ name: "pr-monitor", version: "([^"]+)" \}\)/.exec(serverSource)?.[1]
versions.push(["Claude MCP", serverVersion])

const drift = versions.filter(([, version]) => version !== expected)
if (drift.length > 0) {
  throw new Error(`release version drift: ${versions.map(([name, version]) => `${name}=${version}`).join(", ")}`)
}
console.log(`version check passed: ${versions.map(([name]) => name).join(", ")} = ${expected}`)
