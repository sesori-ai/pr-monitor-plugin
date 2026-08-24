import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const raw = execFileSync(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
})
const parsed = JSON.parse(raw)
const metadata = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
if (!metadata || !Array.isArray(metadata.files)) throw new Error("npm pack returned no file manifest")
const packed = new Set(metadata.files.map((file) => file.path))
const visited = new Set()

function resolveImport(importer, specifier) {
  const base = resolve(dirname(importer), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.js`, resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`cannot resolve ${specifier} imported by ${relative(process.cwd(), importer)}`)
}

function visit(file) {
  const path = relative(process.cwd(), file)
  if (visited.has(path)) return
  visited.add(path)
  if (!packed.has(path)) throw new Error(`packed OpenCode import graph is missing ${path}`)

  const source = readFileSync(file, "utf8")
  const imports = /(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g
  for (const match of source.matchAll(imports)) visit(resolveImport(file, match[1]))
}

visit(resolve(process.cwd(), "opencode/index.ts"))
console.log(`pack check passed: ${packed.size} files; ${visited.size} local imports reachable from opencode/index.ts`)
