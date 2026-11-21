// Lints and format-checks the Hermes Python adapter with a pinned ruff (settings in ruff.toml).
// Uses ruff from PATH when it is the pinned version, otherwise `uvx ruff@<pinned>`.
// Without either it says so loudly; under CI that is a failure, locally it is not.
import { spawnSync } from "node:child_process"

// Keep in sync with the `pip install ruff==` step in .github/workflows/ci.yml.
const RUFF_VERSION = "0.17.5"
const targets = ["hermes", "test/hermes_adapter_test.py"]

function probe(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : undefined
}

const pathVersion = probe("ruff", ["--version"])
let runner
if (pathVersion === `ruff ${RUFF_VERSION}`) runner = ["ruff", []]
else if (probe("uvx", ["--version"]) !== undefined) runner = ["uvx", [`ruff@${RUFF_VERSION}`]]

if (runner === undefined) {
  const found = pathVersion === undefined ? "no ruff on PATH" : `found ${pathVersion}`
  console.error(
    `Python lint NOT run: ruff ${RUFF_VERSION} is unavailable (${found}, no uvx). ` +
      `Install it with \`pip install ruff==${RUFF_VERSION}\` or install uv.`,
  )
  process.exit(process.env["CI"] ? 1 : 0)
}

const [command, prefix] = runner
let failed = false
for (const step of [["check"], ["format", "--check"]]) {
  const result = spawnSync(command, [...prefix, ...step, ...targets], { stdio: "inherit" })
  if (result.status !== 0) failed = true
}
if (failed) console.error("Python lint failed. Run `ruff format hermes test/hermes_adapter_test.py` to fix formatting.")
process.exit(failed ? 1 : 0)
