import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const source = fileURLToPath(new URL("../claude-code/src/mcp-server.ts", import.meta.url))
const output = fileURLToPath(new URL("../claude-code/dist/mcp-server.mjs", import.meta.url))
await build({
  entryPoints: [source],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  logLevel: "warning",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
})
