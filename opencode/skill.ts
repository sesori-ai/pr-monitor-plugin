// Reads the packaged monitor-pr skill so the plugin can register it through
// OpenCode's skill transform. The parser covers exactly the frontmatter shapes
// the canonical SKILL.md uses (plain and folded `>-`/`>` scalars).

import { readFile } from "node:fs/promises"
import { basename, dirname } from "node:path"

export type PackagedSkill = {
  id: string
  name: string
  description: string
  path: string
  content: string
}

export function parseSkillMarkdown({ path, text }: { path: string; text: string }): PackagedSkill {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (match === null) throw new Error(`skill file ${path} has no frontmatter`)
  const fields = parseFrontmatter({ frontmatter: match[1] ?? "" })
  const name = fields.get("name")
  const description = fields.get("description")
  if (!name || !description) throw new Error(`skill file ${path} must declare a name and description`)
  return { id: basename(dirname(path)), name, description, path, content: text.slice(match[0].length) }
}

export async function readPackagedSkill({ path }: { path: string }): Promise<PackagedSkill> {
  return parseSkillMarkdown({ path, text: await readFile(path, "utf8") })
}

function parseFrontmatter({ frontmatter }: { frontmatter: string }): Map<string, string> {
  const fields = new Map<string, string>()
  const lines = frontmatter.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const entry = (lines[index] ?? "").match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (entry === null) continue
    const key = entry[1] ?? ""
    const value = (entry[2] ?? "").trim()
    if (value !== ">" && value !== ">-") {
      fields.set(key, value.replace(/^(["'])(.*)\1$/, "$2"))
      continue
    }
    const folded: string[] = []
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1] ?? "")) {
      index += 1
      folded.push((lines[index] ?? "").trim())
    }
    fields.set(key, folded.join(" "))
  }
  return fields
}
