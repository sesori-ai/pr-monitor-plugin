export enum MonitorAction {
  start = "start",
  stop = "stop",
  flush = "flush",
  status = "status",
  markReady = "mark_ready",
  unmarkReady = "unmark_ready",
  setAutoMerge = "set_auto_merge",
  feedback = "feedback",
  reply = "reply",
}

export const MONITOR_ACTION_VALUES = [
  MonitorAction.start,
  MonitorAction.stop,
  MonitorAction.flush,
  MonitorAction.status,
  MonitorAction.markReady,
  MonitorAction.unmarkReady,
  MonitorAction.setAutoMerge,
  MonitorAction.feedback,
  MonitorAction.reply,
] as const

export const THREAD_PARAM_DESCRIPTION =
  "reply only. Review thread id from feedback (e.g. PRRT_...); omit it to post a PR comment instead."

export const BODY_PARAM_DESCRIPTION =
  "reply only. Reply text; the configured reply prefix is added automatically."

export const AUTO_MERGE_PARAM_DESCRIPTION =
  "start and set_auto_merge only. Explicitly enable (true) or disable (false) auto-merge for this monitor, " +
  "overriding autoMerge config and SESORI_PR_MONITOR_AUTO_MERGE. Set it only when the user asks to enable or " +
  "disable auto-merge; omit it on start otherwise so configuration decides. Required for set_auto_merge."

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
    "Monitor a GitHub PR in the background. Detects head changes, CI conclusions, reviews, inline/issue comments " +
    "(including follow-ups on existing or resolved threads), mergeability changes, and merge/close. Activity is " +
    `aggregated with a rolling debounce; ${delivery} Reports never include comment bodies. Every report states ` +
    "whether the configured ready label is present and tells the agent to keep working or manually mark ready when " +
    "judgment says no action remains. Startup reports normally observe the existing label; when autoMerge is " +
    "enabled by trusted config, SESORI_PR_MONITOR_AUTO_MERGE=true, or the start autoMerge argument, start removes a pre-existing ready label and " +
    "requires fresh assessment. " +
    "Assess current-head checks, automated reviews and feedback immediately, including after restarting a monitor. " +
    "Mark an already-settled PR " +
    "ready without waiting for a new event, but never infer readiness from empty results after creation or a fresh push. " +
    "On later activity, the monitor automatically adds readiness when CI is passing (or absent), " +
    "mergeability is definite, and every feedback channel ends in a correctly prefixed local-account reply. It " +
    "withdraws readiness on later commits, relevant comments, CI regression, or conflict. A newly failing check " +
    "(when flushOnCiFailure is enabled), readiness withdrawal, merge conflict, or terminal state skips debounce. " +
    "The monitor owns all polling and notifications arrive automatically. NEVER create sleeps, delayed or scheduled " +
    "jobs, background polling loops, repeated `gh pr checks`, or routine status/flush calls while waiting. " +
    `${waiting} Actions: start (watch one PR), stop (stop one or all), flush (on-demand full report; never routine ` +
    "after a delivered report), status (list this session's monitors), mark_ready (unconditionally accept current " +
    "state and add the configured ready label), and unmark_ready (remove it now; automation may restore it after a " +
    "later clean assessment), and set_auto_merge (turn auto-merge on or off for an active monitor on explicit user " +
    "request; enabling it on an already-ready PR removes the label so the current head is reassessed), feedback " +
    "(fetch the bodies of every thread, PR comment and review summary still awaiting a reply), and reply (post a " +
    "prefixed reply to a review thread, or a PR comment when thread is omitted). The ready " +
    "label means the agent's work is done; without auto-merge a human reviews next. With autoMerge enabled, the " +
    "user has chosen to merge without waiting for human review: automatic readiness and mark_ready make one " +
    "squash-merge attempt for the accepted head using only the PR title, so call mark_ready as soon as nothing is " +
    "left to do and never hold it back to wait for a human. Rejected or unknown outcomes keep readiness and are " +
    "not retried automatically, while a changed head cancels standalone readiness. " +
    "Ready actions do not require an active monitor. The PR must be `owner/repo#123` or a " +
    `full URL; \`all\` is allowed only for stop/flush. Global tuning lives in ` +
    `~/.config/pr-monitor/config.json; ${configPath} overrides it. An explicit SESORI_PR_MONITOR_AUTO_MERGE ` +
    `environment value overrides autoMerge config; the start autoMerge argument overrides both for that monitor and ` +
    `must be set only on explicit user request, as must set_auto_merge. ${lifecycle}`
  )
}
