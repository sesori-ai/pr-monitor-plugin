# @sesori/pr-monitor-pi

Pi and Oh My Pi (OMP) extension that watches GitHub pull requests in the
background and delivers factual `[PR Monitor]` reports into the active session.

## Install

Pi 0.84.2 or newer:

```sh
pi install npm:@sesori/pr-monitor-pi
```

OMP 18.0.3 or newer:

```sh
omp plugin install @sesori/pr-monitor-pi
```

The package supplies the upstream entry to Pi and the OMP compatibility entry
to OMP automatically. Requirements: Node.js 22.19 or newer for Pi (or the Bun
runtime bundled with OMP), plus an installed and authenticated GitHub CLI
(`gh auth status`).

## Behavior

The extension registers `pr_monitor` actions for `start`, `stop`, `flush`,
`status`, `mark_ready`, and `unmark_ready`. It reports CI conclusions and new
failures, reviews and comments, merge conflicts, and merged/closed state.
Reports contain facts only and are delivered through the host's native custom
message API with turn triggering enabled.

The package also supplies one `monitor-pr` skill. It teaches the agent to start
a monitor immediately after opening a PR, handle every automatic report, wait
for confirmed label success before handoff, and end the turn instead of making
its own wait or polling loop.

Monitors are in memory and belong to the active agent session. Pi clears them
when the current extension instance shuts down after a successful session
replacement or reload. OMP clears them after its successful session-switch
event. Canceled transitions leave the current monitor untouched. Neither host
restores monitors after process restart.

## Configuration

A trusted project uses repository `.pr-monitor.json`, then
`${CONFIG_DIR_NAME}/pr-monitor.json` (`.pi` in Pi and `.omp` in OMP), then
`.opencode/pr-monitor.json`. Pi ignores all project-local monitor config until
the project is trusted. Available settings:

- `debounceMinutes`, `maxCiWaitMinutes`, and `pollIntervalSeconds`
- `ignoreCommentTag`
- `announceOnStart` and `flushOnCiFailure`
- `readyLabel`

See the [repository README](https://github.com/sesori-ai/opencode-pr-monitor#readme)
for action semantics, defaults, and development/release instructions. Durable behavior and artifact checks are in
the repository's [regression catalog](https://github.com/sesori-ai/opencode-pr-monitor/tree/main/docs/regression):
`pull-request-monitoring.md` and `plugin-installation.md`.

## License

MIT
