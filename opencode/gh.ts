// GitHub CLI runner for OpenCode's injected Bun shell.

import type { PluginInput } from "@opencode-ai/plugin"
import { PollError, type GhRunner } from "../core/github"

export function createOpenCodeGhRunner({ shell }: { shell: PluginInput["$"] }): GhRunner {
  return async (args) => {
    const result = await shell`gh ${args}`.quiet().nothrow()
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      const notFound = /could not resolve to|not found|404/i.test(stderr) && !/could not resolve host/i.test(stderr)
      throw new PollError(stderr || `gh exited with code ${result.exitCode}`, { notFound })
    }
    return result.stdout.toString()
  }
}
