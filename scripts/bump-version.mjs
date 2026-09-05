// `make bump VERSION=X.Y.Z`: write one version into every place check-versions.mjs
// reads, and cut the CHANGELOG "Unreleased" section under that version. The
// lockfile is refreshed by the Makefile afterwards (npm install --package-lock-only).

import { readFile, writeFile } from "node:fs/promises"

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: node scripts/bump-version.mjs X.Y.Z")
  process.exit(1)
}

const root = new URL("../", import.meta.url)
const manifests = [
  "opencode/package.json",
  "pi/package.json",
  "claude-code/.claude-plugin/plugin.json",
  "claude-code/.codex-plugin/plugin.json",
]
for (const path of manifests) {
  const url = new URL(path, root)
  const text = await readFile(url, "utf8")
  // Textual replace keeps each file's formatting untouched.
  const next = text.replace(/^(\s*"version":\s*)"[^"]+"/m, `$1"${version}"`)
  if (next === text) throw new Error(`${path}: no version field replaced`)
  await writeFile(url, next)
}

const serverUrl = new URL("claude-code/src/mcp-server.ts", root)
const server = await readFile(serverUrl, "utf8")
const nextServer = server.replace(
  /new McpServer\(\{ name: "pr-monitor", version: "[^"]+" \}\)/,
  `new McpServer({ name: "pr-monitor", version: "${version}" })`,
)
if (nextServer === server) throw new Error("mcp-server.ts: McpServer version not replaced")
await writeFile(serverUrl, nextServer)

const changelogUrl = new URL("CHANGELOG.md", root)
const changelog = await readFile(changelogUrl, "utf8")
if (changelog.includes(`## [${version}]`)) {
  console.log(`CHANGELOG.md already has a [${version}] section; left as is`)
} else if (!/^## \[Unreleased\]\r?\n/m.test(changelog)) {
  throw new Error("CHANGELOG.md has no '## [Unreleased]' heading to cut from")
} else {
  await writeFile(changelogUrl, changelog.replace(/^## \[Unreleased\]\r?\n/m, `## [Unreleased]\n\n## [${version}]\n`))
}
console.log(`version ${version} written to ${manifests.length} manifests, mcp-server.ts, and CHANGELOG.md`)
