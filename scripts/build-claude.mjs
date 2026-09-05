import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const source = fileURLToPath(new URL("../claude-codex/src/mcp-server.ts", import.meta.url))
const output = fileURLToPath(new URL("../claude-codex/dist/mcp-server.mjs", import.meta.url))
await build({
  entryPoints: [source],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  logLevel: "warning",
  banner: {
    // Shebang + exec bit: Codex can only launch a plugin server as a contained
    // `./` path (see claude-codex/.codex-mcp.json); Claude Code runs it via node.
    js:
      "#!/usr/bin/env node\n" +
      "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
chmodSync(output, 0o755)

// Keep both hosts on the same hook implementation and events. Codex also needs
// SessionStart to register the conversation before the first MCP call.
const hooksUrl = new URL("../claude-codex/hooks/hooks.json", import.meta.url)
const codexHooks = JSON.parse(readFileSync(hooksUrl, "utf8"))
for (const entries of Object.values(codexHooks.hooks)) {
  for (const entry of entries) for (const hook of entry.hooks) {
    hook.command = hook.command.replace(/ \|\| true$/, " --codex || true")
  }
}
codexHooks.hooks.SessionStart = codexHooks.hooks.UserPromptSubmit
writeFileSync(new URL("codex-hooks.json", hooksUrl), JSON.stringify(codexHooks, null, 2) + "\n")
