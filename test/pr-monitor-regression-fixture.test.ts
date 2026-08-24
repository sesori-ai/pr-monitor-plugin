import assert from "node:assert/strict"
import test from "node:test"

test("disposable PR monitor failing-CI fixture", () => {
  assert.fail("intentional disposable regression failure")
})
