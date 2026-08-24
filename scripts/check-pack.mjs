import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const npmCli = process.env["npm_execpath"]
if (npmCli === undefined) throw new Error("npm_execpath is missing; run this check through npm run pack:check")
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pr-monitor-opencode-pack-"))

try {
  const raw = execFileSync(
    process.execPath,
    [
      npmCli,
      "pack",
      "--workspace",
      "@sesori/pr-monitor-opencode",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temporaryDirectory,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, npm_config_dry_run: "false" },
    },
  )
  const parsed = JSON.parse(raw)
  const metadata = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  if (!metadata || !Array.isArray(metadata.files) || typeof metadata.filename !== "string") {
    throw new Error("npm pack returned no OpenCode file manifest")
  }

  const files = metadata.files.map((file) => file.path).sort()
  const expectedFiles = ["LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "package.json"]
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    throw new Error(`unexpected OpenCode package files: ${files.join(", ")}`)
  }

  const rootLicense = await readFile(new URL("../LICENSE", import.meta.url), "utf8")
  const packageLicense = await readFile(new URL("../opencode/LICENSE", import.meta.url), "utf8")
  if (rootLicense !== packageLicense) throw new Error("opencode/LICENSE has drifted from the repository license")

  const consumerDirectory = join(temporaryDirectory, "consumer")
  await mkdir(consumerDirectory)
  await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }))
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumerDirectory,
      resolve(temporaryDirectory, metadata.filename),
    ],
    {
      cwd: process.cwd(),
      stdio: "pipe",
      env: { ...process.env, npm_config_dry_run: "false" },
    },
  )
  const smoke =
    'const root = await import("@sesori/pr-monitor-opencode");' +
    'const server = await import("@sesori/pr-monitor-opencode/server");' +
    'const {createRequire} = await import("node:module");' +
    'const manifest = createRequire(import.meta.url)("@sesori/pr-monitor-opencode/package.json");' +
    'const expected = "PrMonitorPlugin";' +
    'if (Object.keys(root).join() !== expected || Object.keys(server).join() !== expected) process.exit(1);' +
    'if (manifest.name !== "@sesori/pr-monitor-opencode") process.exit(1);'
  execFileSync(process.execPath, ["--input-type=module", "--eval", smoke], {
    cwd: consumerDirectory,
    stdio: "pipe",
  })
  await writeFile(
    join(consumerDirectory, "index.ts"),
    'import type { Plugin } from "@opencode-ai/plugin"\n' +
      'import { PrMonitorPlugin } from "@sesori/pr-monitor-opencode"\n' +
      'import { PrMonitorPlugin as ServerPlugin } from "@sesori/pr-monitor-opencode/server"\n' +
      "const root: Plugin = PrMonitorPlugin\nconst server: Plugin = ServerPlugin\nvoid root\nvoid server\n",
  )
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      join(consumerDirectory, "index.ts"),
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  )

  console.log(
    `OpenCode pack check passed: ${metadata.filename}; exact files, typed exports, and package metadata`,
  )
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
