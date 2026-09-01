import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { messagingChannel, pushMessage } from "../claude-code/src/push"

test("messagingChannel resolves socket and token from the env", () => {
  assert.equal(messagingChannel({}), undefined)
  assert.equal(messagingChannel({ CLAUDE_CODE_MESSAGING_SOCKET: "" }), undefined)
  assert.deepEqual(messagingChannel({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock" }), {
    socketPath: "/tmp/x.sock",
    token: undefined,
  })
  assert.deepEqual(
    messagingChannel({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock", CLAUDE_CODE_MESSAGING_TOKEN: "tok" }),
    { socketPath: "/tmp/x.sock", token: "tok" },
  )
})

async function withUdsServer(
  run: (input: { socketPath: string; received: () => Promise<string[]> }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pr-monitor-push-"))
  const socketPath = join(dir, "session.sock")
  let resolveLines: (lines: string[]) => void
  const lines = new Promise<string[]>((resolve) => {
    resolveLines = resolve
  })
  // allowHalfOpen mirrors Claude Code's uds-messaging server: it reads until
  // the client half-closes, then closes its own side.
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    let buffer = ""
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
    })
    socket.on("end", () => {
      resolveLines(buffer.split("\n").filter((line) => line.trim().length > 0))
      socket.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  try {
    await run({ socketPath, received: () => lines })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
}

// Windows cannot bind a Unix-domain socket at a filesystem path, and the
// messaging-socket channel is a Unix feature: a Windows host provides no
// bindable socket and takes the spool fallback, whose trigger is still covered
// below by the connect-failure test.
const udsSkip = process.platform === "win32" ? "Unix-domain sockets are not bindable on Windows" : false

test("pushMessage sends the auth line then the user message and resolves", { skip: udsSkip }, async () => {
  await withUdsServer(async ({ socketPath, received }) => {
    await pushMessage({
      channel: { socketPath, token: "secret" },
      text: "[PR Monitor] hello",
    })
    const lines = (await received()).map((line) => JSON.parse(line))
    assert.deepEqual(lines, [
      { type: "auth", token: "secret" },
      { type: "user", message: { role: "user", content: "[PR Monitor] hello" } },
    ])
  })
})

test("pushMessage omits the auth line when the host granted no token", { skip: udsSkip }, async () => {
  await withUdsServer(async ({ socketPath, received }) => {
    await pushMessage({ channel: { socketPath, token: undefined }, text: "report" })
    const lines = (await received()).map((line) => JSON.parse(line))
    assert.deepEqual(lines, [{ type: "user", message: { role: "user", content: "report" } }])
  })
})

test("pushMessage rejects when nothing listens so delivery can fall back to the spool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-monitor-push-"))
  try {
    await assert.rejects(
      pushMessage({ channel: { socketPath: join(dir, "gone.sock"), token: undefined }, text: "report" }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
