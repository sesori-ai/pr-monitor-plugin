export enum MonitorAction {
  start = "start",
  stop = "stop",
  flush = "flush",
  status = "status",
  markReady = "mark_ready",
  unmarkReady = "unmark_ready",
}

export const MONITOR_ACTION_VALUES = [
  MonitorAction.start,
  MonitorAction.stop,
  MonitorAction.flush,
  MonitorAction.status,
  MonitorAction.markReady,
  MonitorAction.unmarkReady,
] as const

export function buildMonitorToolDescription({
  delivery,
  configPath,
  lifecycle,
  waiting,
}: {
  delivery: string
  configPath: string
  lifecycle: string
  waiting: string
}): string {
  return (
    "Monitor a GitHub PR in the background. Detects CI conclusions, reviews, inline/issue comments (including " +
    "follow-ups on existing or resolved threads), mergeability changes, and merge/close. Activity is aggregated with " +
    `a rolling debounce; ${delivery} Reports state facts only. A newly failing check (when flushOnCiFailure is ` +
    "enabled), merge conflict, or terminal PR state skips debounce and is reported at the next poll. The monitor " +
    "itself owns all polling and notifications " +
    "arrive automatically. NEVER create sleeps, delayed or scheduled jobs, background polling loops, repeated `gh pr " +
    "checks`, or routine status/flush calls while waiting for CI or review. " +
    `${waiting} Actions: start (watch one PR), stop (stop one or all), flush (on-demand full report; never routine ` +
    "after a delivered report), status (list this session's monitors), mark_ready (add the configured ready label " +
    "after CI/review is clean; never claim handoff unless it confirms success), and unmark_ready (withdraw it before " +
    "handling later feedback). Ready actions do not " +
    "require an active monitor. The PR must be `owner/repo#123` or a full URL; `all` is allowed only for stop/flush. " +
    `Tuning lives in ${configPath}. ${lifecycle}`
  )
}
