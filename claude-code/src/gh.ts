// GitHub CLI runner for the Claude Code shell: runs `gh` via child_process
// instead of opencode's Bun $ shell, with the same PollError semantics.

import { execFile } from "node:child_process"
import { PollError, type GhRunner } from "../../core/github"

export function createNodeGhRunner(): GhRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("gh", args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message
          const notFound = /could not resolve to|not found|404/i.test(message) && !/could not resolve host/i.test(message)
          reject(new PollError(message, { notFound }))
          return
        }
        resolve(stdout)
      })
    })
}
