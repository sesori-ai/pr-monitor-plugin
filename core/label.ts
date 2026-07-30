// Marking a PR as ready for human review: apply a label via the GitHub REST
// API. The label is ensured to exist first so it gets a deliberate color and
// description — the add-labels endpoint auto-creates missing labels, but as
// default grey with no description.

import { PollError, type GhRunner } from "./github"
import { targetKey, type Target } from "./target"

const READY_LABEL_COLOR = "0e8a16" // GitHub's standard green
const READY_LABEL_DESCRIPTION = "This PR is ready for human review"

/**
 * Adds `label` to the PR, creating the label in the repo first (green, with a
 * description) if it does not exist yet. Idempotent: adding an already-present
 * label succeeds and keeps the repo's existing label definition. Returns a
 * factual result line; throws when the target is not an open PR or the add
 * fails.
 */
export async function markReadyForHumanReview(runGh: GhRunner, target: Target, label: string): Promise<string> {
  const repo = `repos/${target.owner}/${target.repo}`
  // Verify the target is an actual OPEN pull request first. The labels
  // endpoint below operates on the shared issue namespace, so without this
  // check a plain issue number — or a merged/closed PR — would be silently
  // labeled and reported as success.
  let raw: string
  try {
    raw = await runGh(["api", `${repo}/pulls/${target.number}`])
  } catch (error) {
    if (error instanceof PollError && error.notFound) {
      // The caller prefixes the target key; do not repeat it here.
      throw new Error(`it is not a pull request, or it does not exist or is not accessible.`)
    }
    throw error
  }
  const pr = JSON.parse(raw) as { state?: string; merged?: boolean }
  if (pr.merged === true || pr.state !== "open") {
    throw new Error(`the PR is already ${pr.merged === true ? "MERGED" : "CLOSED"}.`)
  }
  try {
    await runGh([
      "api",
      `${repo}/labels`,
      "-f",
      `name=${label}`,
      "-f",
      `color=${READY_LABEL_COLOR}`,
      "-f",
      `description=${READY_LABEL_DESCRIPTION}`,
    ])
  } catch {
    // Almost always 422 already_exists — keep the repo's version of the label.
    // Real problems (auth, missing repo) surface on the add call below.
  }
  await runGh(["api", `${repo}/issues/${target.number}/labels`, "-f", `labels[]=${label}`])
  return `Marked ${targetKey(target)} as ready for human review: label "${label}" added.`
}
