import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const configuredCli = process.env["OPENCODE_CLI"]
const openCodeCli = configuredCli === undefined ? "opencode" : resolve(configuredCli)
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pr-monitor-opencode-host-"))
const projectDirectory = join(temporaryDirectory, "project")
const configDirectory = join(temporaryDirectory, "config")

function runOpenCode({ args, timeout = 60_000 }) {
  const result = spawnSync(openCodeCli, args, {
    cwd: projectDirectory,
    encoding: "utf8",
    env: isolatedEnvironment(),
    timeout,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`OpenCode ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function isolatedEnvironment() {
  return {
    ...process.env,
    XDG_CONFIG_HOME: configDirectory,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  }
}

try {
  await mkdir(projectDirectory)
  await mkdir(configDirectory)
  const pluginUrl = pathToFileURL(resolve("opencode/dist/index.js")).href
  await writeFile(join(projectDirectory, "opencode.json"), `${JSON.stringify({ plugin: [pluginUrl] })}\n`)

  const version = runOpenCode({ args: ["--version"] }).trim()
  const skills = JSON.parse(runOpenCode({ args: ["debug", "skill"] }))
  assert.equal(skills.filter((skill) => skill.name === "monitor-pr").length, 1)

  const server = spawn(openCodeCli, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: projectDirectory,
    env: isolatedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  const timeout = setTimeout(() => server.kill("SIGTERM"), 30_000)
  try {
    const baseUrl = await new Promise((resolveUrl, reject) => {
      const inspect = (chunk) => {
        output += chunk.toString()
        const match = output.match(/https?:\/\/127\.0\.0\.1:\d+/)
        if (match !== null) resolveUrl(match[0])
      }
      server.stdout.on("data", inspect)
      server.stderr.on("data", inspect)
      server.once("error", reject)
      server.once("exit", (code) => reject(new Error(`OpenCode exited before listening (${code}): ${output}`)))
    })
    const response = await fetch(
      `${baseUrl}/experimental/tool/ids?directory=${encodeURIComponent(projectDirectory)}`,
    )
    if (!response.ok) throw new Error(`OpenCode tool endpoint returned ${response.status}: ${await response.text()}`)
    const toolIds = await response.json()
    assert.equal(toolIds.filter((toolId) => toolId === "pr_monitor").length, 1)
  } finally {
    clearTimeout(timeout)
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((resolveExit) => server.once("exit", resolveExit))
      server.kill("SIGTERM")
      await exited
    }
  }

  console.log(`OpenCode loader check passed on ${process.platform}: ${version}; one tool and one skill`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
