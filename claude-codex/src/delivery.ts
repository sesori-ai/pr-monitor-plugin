// Delivery decision for the Claude Code / Codex adapter, kept free of I/O so
// it can be tested directly.

import { ReportKind } from "../../core/watch"

export enum DeliveryRoute {
  push = "push",
  spool = "spool",
  drop = "drop",
}

export type DeliveryPlan = {
  route: DeliveryRoute
  // Whether delivery refreshes the rolling keepAliveMaxMinutes idle cap.
  extendKeepAlive: boolean
  // Whether desktopNotifications may show a popup. Idle reminders are for the
  // agent only.
  notifyDesktop: boolean
}

// Whether a watched PR is handed off, which releases the hook-based keep-alive
// loop. A ready PR whose auto-merge attempt was rejected or came back unknown
// is still unmerged work, so it keeps the loop armed (still capped by
// keepAliveMaxMinutes) and its idle reminder can reach the session.
export function isHandedOff({
  ready,
  watched,
  mergeStuck,
}: {
  ready: boolean
  watched: boolean
  mergeStuck: boolean
}): boolean {
  return ready && watched && !mergeStuck
}

export function planDelivery({
  kind,
  hasPushChannel,
  keepAliveArmed,
  nowMs,
  keepAliveUntilMs,
}: {
  kind: ReportKind
  hasPushChannel: boolean
  // Session-wide: some watch not yet handed off has keepAlive on. The reminded
  // PR itself may be handed off (ready with a stuck auto-merge) while another
  // watch keeps the loop waiting.
  keepAliveArmed: boolean
  nowMs: number
  keepAliveUntilMs: number
}): DeliveryPlan {
  // An idle reminder is not PR activity: it must never extend the keep-alive
  // idle cap, or a still PR would hold the session open forever.
  const reminder = kind === ReportKind.idleReminder
  if (hasPushChannel) return { route: DeliveryRoute.push, extendKeepAlive: !reminder, notifyDesktop: !reminder }
  if (!reminder) return { route: DeliveryRoute.spool, extendKeepAlive: true, notifyDesktop: true }
  // A spooled report wakes the session only while the keep-alive loop holds
  // it. Drop a reminder nothing would read before the next prompt instead of
  // stacking stale reminders in the spool.
  const held = keepAliveArmed && nowMs < keepAliveUntilMs
  return { route: held ? DeliveryRoute.spool : DeliveryRoute.drop, extendKeepAlive: false, notifyDesktop: false }
}
