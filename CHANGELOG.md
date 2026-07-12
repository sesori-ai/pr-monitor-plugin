# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6]

### Fixed

- Graceful opencode shutdowns now stop active timers, deliver a factual stop notice to each owning session, and await all delivery attempts before plugin disposal completes. Abrupt process termination remains undetectable.

## [0.1.5]

### Fixed

- Mergeability tracking now compares against the last *definite* state (MERGEABLE/CONFLICTING) instead of the immediately previous poll. A real `MERGEABLE -> UNKNOWN -> CONFLICTING` settle spans two polls; because `0.1.4` suppressed every UNKNOWN-side transition, once the previous snapshot became the transient UNKNOWN the genuine conflict was swallowed and never reported. Carrying the last definite value across UNKNOWN polls keeps base-branch churn quiet while still catching a conflict once it resolves.

## [0.1.4]

### Changed

- Transient `UNKNOWN` mergeability churn from base-branch merges (`MERGEABLE -> UNKNOWN -> MERGEABLE`) no longer counts as activity; only settled transitions between definite mergeability states are report-worthy.

## [0.1.3]

### Added

- `announceOnStart` config option (default `true`): on start, a monitor delivers a full status report immediately so the session sees its starting point and can address anything already outstanding on the PR (including comments added during a delayed startup, which periodic polling would otherwise treat as pre-existing and never report). Set `false` to disable.

## [0.1.2]

### Added

- Reports render the PR as a clickable Markdown link (`[owner/repo#n](url)`); all `[PR Monitor]` messages are Markdown.
- Merged/closed PR reports end with a `Monitor stopped: PR merged|closed` line, so a self-close is explicit.

### Changed

- Every stop reason now uses one consistent `Monitor stopped: <reason>` phrasing (terminal merge/close, PR not found, repeated poll failures, plugin reload).
- The `flush` action is documented as on-demand: a delivered report already advances the "new since" baseline, so a manual flush after handling a report is not needed.

## [0.1.1]

### Fixed

- Report deliveries reuse the session's last user-selected model (captured via the `chat.message` hook) instead of letting the server re-resolve the model at delivery time, which on a long-lived watch could drift onto a model that had since been removed.

## [0.1.0]

### Added

- Initial release: a background GitHub PR monitor that delivers factual `[PR Monitor]` reports into the owning opencode session.
