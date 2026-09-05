// pr-monitor — active delivery over Claude Code's per-session messaging socket.
//
// Claude Code binds a Unix messaging socket per session (its uds-messaging
// layer, the transport behind cross-session SendMessage) and exports
// CLAUDE_CODE_MESSAGING_SOCKET / CLAUDE_CODE_MESSAGING_TOKEN to child
// processes — which includes this MCP server. The wire protocol is
// newline-delimited JSON: one auth line, then message lines. A
// `{"type":"user"}` line injects a visible user message into the owning
// session — starting a turn when the session is idle and surfacing mid-turn
// when it is busy. That gives Claude Code the same push delivery as OpenCode's
// `promptAsync` and Pi's `sendMessage`; the spool + hook path remains the
// fallback for hosts without the socket (older Claude Code, headless modes,
// or a refused sockets directory).
//
// Known residue: the injection has no acknowledgement in the protocol, so a
// clean close is the success signal. A stale auth token (the messaging server
// restarted underneath a still-running MCP server) is indistinguishable from
// success here; the next `/mcp` reconnect re-reads the env and heals it.

import { connect } from "node:net"
import process from "node:process"

export type PushChannel = {
  socketPath: string
  /** Absent on platforms where Claude Code runs the socket without auth. */
  token: string | undefined
}

/**
 * The messaging channel Claude Code granted this process, or undefined when
 * the host predates the socket (or runs without one) and delivery must fall
 * back to the spool.
 */
export function messagingChannel(env: NodeJS.ProcessEnv = process.env): PushChannel | undefined {
  const socketPath = env["CLAUDE_CODE_MESSAGING_SOCKET"]
  if (socketPath === undefined || socketPath.length === 0) return undefined
  const token = env["CLAUDE_CODE_MESSAGING_TOKEN"]
  return { socketPath, token: token !== undefined && token.length > 0 ? token : undefined }
}

const SOCKET_TIMEOUT_MS = 3_000

/**
 * Push one message into the owning session. Resolves on a clean close after
 * the write, and on a quiet post-write timeout (a live server holds the bytes
 * and merely closed slowly; retrying would inject the report twice). Rejects
 * on any socket error — even after the write flushed, an errored connection
 * cannot prove the server read the bytes, and a lost report is worse than the
 * duplicate a retry risks — and on pre-write timeout or connection failure.
 */
export function pushMessage({ channel, text }: { channel: PushChannel; text: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: channel.socketPath })
    let failure: Error | undefined
    let wrote = false
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error !== undefined) reject(error)
      else resolve()
    }
    // A timeout after the write flushed counts as delivered: rejecting there
    // would make the watch retry a message the server already read, injecting
    // it twice. Only a timeout before the write is a failed delivery.
    socket.setTimeout(SOCKET_TIMEOUT_MS, () =>
      wrote ? settle() : settle(new Error("messaging socket timed out")),
    )
    socket.on("error", (error) => {
      // Keep the first error for the close handler; 'close' always follows.
      failure ??= error
    })
    socket.on("connect", () => {
      const lines: string[] = []
      if (channel.token !== undefined) lines.push(JSON.stringify({ type: "auth", token: channel.token }))
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }))
      socket.end(lines.map((line) => `${line}\n`).join(""), () => {
        wrote = true
      })
    })
    socket.on("close", (hadError) => {
      settle(failure ?? (hadError ? new Error("messaging socket closed with an error") : undefined))
    })
  })
}
