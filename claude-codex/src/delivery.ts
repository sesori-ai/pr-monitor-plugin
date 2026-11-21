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
}

export function planDelivery({
  kind,
  hasPushChannel,
  keepAlive,
  handedOff,
  nowMs,
  keepAliveUntilMs,
}: {
  kind: ReportKind
  hasPushChannel: boolean
  keepAlive: boolean
  handedOff: boolean
  nowMs: number
  keepAliveUntilMs: number
}): DeliveryPlan {
  // An idle reminder is not PR activity: it must never extend the keep-alive
  // idle cap, or a still PR would hold the session open forever.
  const reminder = kind === ReportKind.idleReminder
  if (hasPushChannel) return { route: DeliveryRoute.push, extendKeepAlive: !reminder }
  if (!reminder) return { route: DeliveryRoute.spool, extendKeepAlive: true }
  // A spooled report wakes the session only while the keep-alive loop holds
  // it. Drop a reminder nothing would read before the next prompt instead of
  // stacking stale reminders in the spool.
  const held = keepAlive && !handedOff && nowMs < keepAliveUntilMs
  return { route: held ? DeliveryRoute.spool : DeliveryRoute.drop, extendKeepAlive: false }
}
