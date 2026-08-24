import { cp, mkdir, rm } from "node:fs/promises"

const source = new URL("../skills/monitor-pr", import.meta.url)

export async function copyPushSkill({ target }) {
  await rm(target, { recursive: true, force: true })
  await mkdir(new URL("../", target), { recursive: true })
  await cp(source, target, { recursive: true })
}
