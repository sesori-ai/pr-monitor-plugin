import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const bun = process.platform === "win32" ? "bun.exe" : "bun"
const configuredModule = process.env["OMP_LOADER_MODULE"]
const temporaryDirectory = configuredModule === undefined ? await mkdtemp(join(tmpdir(), "pr-monitor-omp-")) : undefined

try {
  let loaderModule = configuredModule
  let ompCli = process.env["OMP_CLI"]
  if (loaderModule === undefined) {
    await writeFile(join(temporaryDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }))
    execFileSync(bun, ["add", "--exact", "@oh-my-pi/pi-coding-agent@18.0.3"], {
      cwd: temporaryDirectory,
      stdio: "inherit",
    })
    const packageDirectory = join(temporaryDirectory, "node_modules", "@oh-my-pi", "pi-coding-agent")
    loaderModule = pathToFileURL(join(packageDirectory, "src", "index.ts")).href
    ompCli ??= join(packageDirectory, "dist", "cli.js")
  }
  ompCli ??= fileURLToPath(new URL("../dist/cli.js", loaderModule))

  execFileSync(bun, ["scripts/check-omp-loader.mjs"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, OMP_LOADER_MODULE: loaderModule },
  })
  execFileSync(process.execPath, ["scripts/check-omp-package.mjs"], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, BUN_BIN: bun, OMP_CLI: ompCli },
  })
} finally {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}
