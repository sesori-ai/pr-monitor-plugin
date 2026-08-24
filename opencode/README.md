# @sesori/pr-monitor-opencode

OpenCode plugin that watches GitHub pull requests in the background and delivers factual `[PR Monitor]` reports to
the session that started each watch.

## Install

Add the package to project or global `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@sesori/pr-monitor-opencode"]
}
```

Requirements: OpenCode 1.17 or newer, plus an installed and authenticated GitHub CLI (`gh auth status`).

## Behavior

The plugin registers `pr_monitor` actions for `start`, `stop`, `flush`, `status`, `mark_ready`, and `unmark_ready`.
It also injects one packaged `monitor-pr` skill through OpenCode's configured skill paths, so consuming repositories
do not need their own copy. The skill tells the agent to start monitoring after opening a PR, handle every automatic
report, confirm the ready label before handoff, and end the turn instead of creating a second wait mechanism.

The monitor reports CI conclusions and new failures, reviews and comments, merge conflicts, and merged/closed state.
Reports contain facts only and are delivered into the owning OpenCode session.

The monitor owns all polling and notifications arrive automatically. Agents must never create sleeps, scheduled
checks, background polling loops, repeated `gh pr checks`, or routine `status`/`flush` calls while waiting.

Monitors are in memory, belong to the OpenCode session that started them, stop on merge/close or session deletion,
and do not survive an OpenCode restart.

## Configuration

Use repository `.pr-monitor.json`; `.opencode/pr-monitor.json` remains a fallback. Available settings:

- `debounceMinutes`, `maxCiWaitMinutes`, and `pollIntervalSeconds`
- `ignoreCommentTag`
- `announceOnStart` and `flushOnCiFailure`
- `readyLabel`

See the [repository README](https://github.com/sesori-ai/opencode-pr-monitor#readme) for action semantics, defaults,
configuration examples, and development/release instructions.

## License

MIT
