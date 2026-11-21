import assert from "node:assert/strict"
import test from "node:test"
import { DeliveryRoute, isHandedOff, planDelivery } from "../claude-codex/src/delivery"
import { ReportKind } from "../core/watch"

const NOW = Date.parse("2026-11-20T12:00:00Z")
const held = { keepAliveArmed: true, nowMs: NOW, keepAliveUntilMs: NOW + 60_000 }

test("reports push with a channel, otherwise spool, and always extend keep-alive", () => {
  const expired = { ...held, keepAliveUntilMs: NOW - 1 }
  assert.deepEqual(planDelivery({ kind: ReportKind.update, hasPushChannel: true, ...held }), {
    route: DeliveryRoute.push,
    extendKeepAlive: true,
  })
  assert.deepEqual(planDelivery({ kind: ReportKind.update, hasPushChannel: false, ...expired }), {
    route: DeliveryRoute.spool,
    extendKeepAlive: true,
  })
})

test("idle reminders push with a channel without extending keep-alive", () => {
  for (const state of [held, { ...held, keepAliveArmed: false, keepAliveUntilMs: 0 }]) {
    assert.deepEqual(planDelivery({ kind: ReportKind.idleReminder, hasPushChannel: true, ...state }), {
      route: DeliveryRoute.push,
      extendKeepAlive: false,
    })
  }
})

test("spooled idle reminders need the session's keep-alive loop holding and never extend it", () => {
  const plan = (state: typeof held) => planDelivery({ kind: ReportKind.idleReminder, hasPushChannel: false, ...state })
  // Armed by any watch not yet handed off, even when the reminded PR itself is
  // ready with a stuck auto-merge.
  assert.deepEqual(plan(held), { route: DeliveryRoute.spool, extendKeepAlive: false })
  for (const notHeld of [{ ...held, keepAliveArmed: false }, { ...held, keepAliveUntilMs: NOW }]) {
    assert.deepEqual(plan(notHeld), { route: DeliveryRoute.drop, extendKeepAlive: false })
  }
})

test("only a watched ready PR without a stuck auto-merge is handed off", () => {
  assert.equal(isHandedOff({ ready: true, watched: true, mergeStuck: false }), true)
  // Rejected or unknown auto-merge: still unmerged work, so keep-alive stays armed.
  assert.equal(isHandedOff({ ready: true, watched: true, mergeStuck: true }), false)
  assert.equal(isHandedOff({ ready: false, watched: true, mergeStuck: false }), false)
  assert.equal(isHandedOff({ ready: true, watched: false, mergeStuck: false }), false)
})
