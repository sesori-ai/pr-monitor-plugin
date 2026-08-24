import { rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { copyPushSkill } from "./copy-push-skill.mjs"

const entryPoints = [
  fileURLToPath(new URL("../pi/index.ts", import.meta.url)),
  fileURLToPath(new URL("../pi/omp.ts", import.meta.url)),
]
await rm(new URL("../pi/dist", import.meta.url), { recursive: true, force: true })
await build({
  entryPoints,
  outdir: fileURLToPath(new URL("../pi/dist", import.meta.url)),
  entryNames: "[name]",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "esnext",
  external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "typebox"],
  logLevel: "warning",
})
const declaration =
  'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"\n\n' +
  "export default function prMonitor(pi: ExtensionAPI): void\n"
await Promise.all([
  writeFile(new URL("../pi/dist/index.d.ts", import.meta.url), declaration),
  writeFile(new URL("../pi/dist/omp.d.ts", import.meta.url), declaration),
])
await copyPushSkill({ target: new URL("../pi/skills/monitor-pr/", import.meta.url) })
