import { execFileSync } from "node:child_process"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))
const source = fileURLToPath(new URL("../opencode/index.ts", import.meta.url))
const output = fileURLToPath(new URL("../opencode/dist/index.js", import.meta.url))
const declaration = fileURLToPath(new URL("../opencode/dist/index.d.ts", import.meta.url))
const declarationDirectory = await mkdtemp(join(tmpdir(), "pr-monitor-opencode-types-"))
try {
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
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
      "--project",
      fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
      "--declaration",
      "--emitDeclarationOnly",
      "--noEmit",
      "false",
      "--outDir",
      declarationDirectory,
    ],
    { cwd: root, stdio: "pipe" },
  )
  await copyFile(join(declarationDirectory, "opencode", "index.d.ts"), declaration)
} finally {
  await rm(declarationDirectory, { recursive: true, force: true })
}
