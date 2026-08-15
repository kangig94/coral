# TODO — define retention for persistent job exports

**Status**: open. Recorded during PR #309 round-4 review on 2026-08-15 after the documented meaning of
`CORAL_JOBS_RETENTION_DAYS` was compared with its cleanup target.

## The gap

Persistent job exports under `~/.coral/exports/jobs/<jobId>/` and the development sibling
`~/.coral/exports-dev/jobs/<jobId>/` are never pruned. They can contain `result.md`, workflow-child
`workflow.json`, and archived provider artifacts. `CORAL_JOBS_RETENTION_DAYS` does not govern either tree:
`cleanupStaleJobs` removes only `<tmpdir>/coral-jobs/<jobId>/` runtime scratch plus the matching durable
CLI-process runtime metadata.

This is both a disk-usage and a privacy-retention gap. Shortening the existing setting does not shorten the
lifetime of exported provider output or native-session archives.

## Why this PR does not delete them

Adding deletion now would silently change the lifetime of user data under an existing setting whose runtime
behavior has never touched that directory. The retention contract needs an explicit operator decision before
the code acquires destructive authority over exports.

## Decision required

Choose whether persistent exports use a separate setting or an explicitly broadened existing setting, define
how archived provider artifacts participate, and specify recovery behavior for rebuildable `result.md` and
`workflow.json` versus non-rebuildable archives. Only then should cleanup resolve and delete exact export
directories.
