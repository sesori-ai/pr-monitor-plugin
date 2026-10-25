// Proves against the real OpenCode V2 CLI that the built plugin loads from its
// local package directory and registers exactly one pr_monitor tool and one
// monitor-pr skill. OpenCode V2 has no tool-listing HTTP route, so a throwaway
// probe plugin in the isolated project exposes the host's live tool registry
// (`ctx.tool.list()`) over plugin RPC.

import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const PLUGIN_ID = "sesori.pr-monitor"
const PROBE_ID = "sesori.pr-monitor.loader-probe"
const PROBE_RPC = "pr-monitor-loader-probe"
const READY_TIMEOUT_MS = 60_000

const configuredCli = process.env["OPENCODE_CLI"]
const openCodeCli = configuredCli === undefined ? "opencode" : resolve(configuredCli)
const pluginDirectory = await realpath(resolve("opencode/dist"))
const pluginEntrypoint = join(pluginDirectory, "index.js")
const skillPath = await realpath(resolve("opencode/skills/monitor-pr/SKILL.md"))
const temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "pr-monitor-opencode-host-")))
const projectDirectory = join(temporaryDirectory, "project")
const homeDirectory = join(temporaryDirectory, "home")
const password = randomBytes(24).toString("hex")

const probeSource = `import { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"

const Probe = Rpc.define({
  id: ${JSON.stringify(PROBE_RPC)},
  methods: {
    tools: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", properties: { tools: { type: "array" } }, required: ["tools"] },
    },
  },
  events: {},
})

export default Plugin.define({
  id: ${JSON.stringify(PROBE_ID)},
  async setup(ctx) {
    await ctx.rpc.register(Probe, {
      tools: async () => ({
        tools: (await ctx.tool.list()).map((tool) => ({ id: tool.id, codemode: tool.options?.codemode ?? true })),
      }),
    })
  },
})
`

function isolatedEnvironment() {
  return {
    ...process.env,
    HOME: homeDirectory,
    XDG_CONFIG_HOME: join(homeDirectory, ".config"),
    XDG_DATA_HOME: join(homeDirectory, ".local", "share"),
    XDG_CACHE_HOME: join(homeDirectory, ".cache"),
    XDG_STATE_HOME: join(homeDirectory, ".local", "state"),
    OPENCODE_SERVER_PASSWORD: password,
  }
}

function openCodeVersion() {
  const result = spawnSync(openCodeCli, ["--version"], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: isolatedEnvironment(),
    timeout: 60_000,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`OpenCode --version failed: ${result.stderr}`)
  return result.stdout.trim()
}

function createClient({ baseUrl }) {
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const location = `location[directory]=${encodeURIComponent(projectDirectory)}`
  const request = async ({ method = "GET", path, body }) => {
    const response = await fetch(`${baseUrl}${path}?${location}`, {
      method,
      headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`OpenCode ${method} ${path} returned ${response.status}: ${text}`)
    return JSON.parse(text)
  }
  return {
    plugins: async () => (await request({ path: "/api/plugin" })).data,
    skills: async () => (await request({ path: "/api/skill" })).data,
    tools: async () =>
      (await request({ method: "POST", path: `/api/rpc/${PROBE_RPC}/tools`, body: { input: {} } })).output.tools,
  }
}

// Plugins load asynchronously on first access to a location; wait for both
// local plugins to settle instead of assuming a fixed startup time.
async function waitForPlugins({ client }) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const local = (await client.plugins()).filter((plugin) => plugin.source.type === "local")
    const states = new Map(local.map((plugin) => [plugin.id, plugin.state.status]))
    if (states.get(PLUGIN_ID) === "active" && states.get(PROBE_ID) === "active") return local
    const failed = local.find((plugin) => plugin.state.status === "failed")
    if (failed !== undefined) throw new Error(`OpenCode plugin failed to load: ${JSON.stringify(failed)}`)
    if (Date.now() > deadline) throw new Error(`OpenCode plugins did not become active: ${JSON.stringify(local)}`)
    await delay(250)
  }
}

async function startServer() {
  const server = spawn(openCodeCli, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: projectDirectory,
    env: isolatedEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  const baseUrl = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode did not start listening: ${output}`)), 30_000)
    const inspect = (chunk) => {
      output += chunk.toString()
      const match = output.match(/listening on (https?:\/\/127\.0\.0\.1:\d+)/)
      if (match === null) return
      clearTimeout(timer)
      resolveUrl(match[1])
    }
    server.stdout.on("data", inspect)
    server.stderr.on("data", inspect)
    server.once("error", reject)
    server.once("exit", (code) => reject(new Error(`OpenCode exited before listening (${code}): ${output}`)))
  })
  return { server, baseUrl }
}

async function stopServer({ server }) {
  if (server.exitCode !== null || server.signalCode !== null) return
  const exited = new Promise((resolveExit) => server.once("exit", resolveExit))
  server.kill("SIGTERM")
  await exited
}

try {
  await mkdir(join(projectDirectory, ".opencode", "plugins", "loader-probe"), { recursive: true })
  await mkdir(homeDirectory)
  await writeFile(join(projectDirectory, "opencode.json"), `${JSON.stringify({ plugins: [pluginDirectory] })}\n`)
  await writeFile(join(projectDirectory, ".opencode", "plugins", "loader-probe", "index.js"), probeSource)

  const version = openCodeVersion()
  const { server, baseUrl } = await startServer()
  try {
    const client = createClient({ baseUrl })
    const local = await waitForPlugins({ client })
    const plugin = local.filter((entry) => entry.id === PLUGIN_ID)
    assert.equal(plugin.length, 1, "exactly one pr-monitor plugin is active")
    assert.equal(plugin[0].source.path, pluginEntrypoint, "the built bundle is the loaded entrypoint")

    const tools = (await client.tools()).filter((tool) => tool.id === "pr_monitor")
    assert.equal(tools.length, 1, "exactly one pr_monitor tool is registered")
    assert.equal(tools[0].codemode, false, "pr_monitor is a direct tool, not a Code Mode catalog entry")

    const skills = (await client.skills()).filter((skill) => skill.id === "monitor-pr")
    assert.equal(skills.length, 1, "exactly one monitor-pr skill is registered")
    assert.equal(skills[0].path, skillPath, "the packaged push-host skill is the registered monitor-pr skill")
  } finally {
    await stopServer({ server })
  }

  console.log(`OpenCode loader check passed on ${process.platform}: ${version}; one tool and one skill`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
