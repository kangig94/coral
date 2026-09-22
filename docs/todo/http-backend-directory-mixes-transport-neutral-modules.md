# The HTTP backend directory still owns transport-neutral modules

**Status**: open. The status selector moved; the directory boundary did not.

## What is wrong

`observeCoordinator` (`src/transport/http/backend/coordinator-observation.ts`) is transport-neutral and is
shared by `backend status` and `backend shutdown`. `parseBackendHealth`
(`src/transport/http/backend/health.ts`) validates health payloads that can arrive over HTTP or authenticated
IPC. Keeping both under `transport/http/backend/` makes the directory describe only one of their carriages.

Relocating `src/cli/backend-status.ts` was the smallest move that kept the selector above both transports
without recreating a transport dependency cycle. It satisfied the constraint for the file this branch
changed, but it deliberately left the surrounding mixed directory unchanged.

## Start condition

Start only as a directory-wide ownership change: inventory every importer, choose one transport-neutral home,
and move `src/transport/http/backend/` as a whole with its citations and invariants. Do not repeat the
status-only relocation one file at a time.
