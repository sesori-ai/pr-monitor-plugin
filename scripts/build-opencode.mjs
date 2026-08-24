import { rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const source = fileURLToPath(new URL("../opencode/index.ts", import.meta.url))
const output = fileURLToPath(new URL("../opencode/dist/index.js", import.meta.url))
const declaration = fileURLToPath(new URL("../opencode/dist/index.d.ts", import.meta.url))
await rm(new URL("../opencode/dist", import.meta.url), { recursive: true, force: true })
await build({
  entryPoints: [source],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "esnext",
  external: ["@opencode-ai/plugin"],
  logLevel: "warning",
})
await writeFile(
  declaration,
  'import type { Plugin } from "@opencode-ai/plugin"\n\nexport declare const PrMonitorPlugin: Plugin\n',
)
