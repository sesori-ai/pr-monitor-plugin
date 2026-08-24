import { fileURLToPath } from "node:url"

export function packageSkillDirectory({ moduleUrl }: { moduleUrl: string }): string {
  return fileURLToPath(new URL("../skills", moduleUrl))
}
