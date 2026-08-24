import { rm } from "node:fs/promises"

await rm(new URL("../opencode/dist", import.meta.url), { recursive: true, force: true })
