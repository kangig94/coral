# Backend status reports a starting coordinator as ok

**Status**: open. The public output for an answered but not-ready coordinator is undecided.

## What is wrong

`statusFromParsedHealth` (`src/cli/backend-status.ts`) preserves `ok` and `draining` but rewrites an answered
health payload's `starting` status to `ok`. `formatRunningStatus` (`src/cli/format/backend.ts`) therefore
prints `Backend ok` for a coordinator whose own health snapshot says it is still starting.

The drain-reporting change deliberately stopped rewriting `draining`; it did not decide what `starting`
should mean on this CLI surface. Fixing that adjacent output now would silently make that decision.

## Start condition

Start after the owner chooses the public status shape and exit contribution for an authenticated coordinator
that answered health but is not ready. The implementation must then update the renderer and every consumer
of that output together, rather than redefining `ok` in place for stale readers.
