# npm run build Kills Running Jobs

## Rule
`npm run build` regenerates `coral-backend.cjs`. The bridge's `ensureBackend` detects the version mismatch and triggers backend replacement. The old backend calls `markJobsAsError('Backend shutting down')` + `killAllChildren()`, terminating all running Codex/Claude CLI child processes. Jobs cannot survive a backend restart because child process pipes (stdin/stdout) are tied to the parent process lifecycle.

## Why
Running `npm run build` during an active Codex workflow or long-running job silently kills it. The job appears as "Unclean shutdown - orphaned job" on the next wait. This is easy to trigger accidentally after fixing a bug mid-workflow.

## Pattern
- Check for running jobs before building: avoid build during active workflows
- If a source fix is needed mid-workflow, edit the source but defer `npm run build` until the job completes
- Bridge-only changes (`src/bridge/`) rebuild `coral-ax.cjs` but the bridge process restarts per-request, so only backend changes (`src/execution/`) kill jobs
