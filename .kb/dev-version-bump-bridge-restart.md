# Version Bump Requires Claude Code Restart

## Rule
After bumping the version and rebuilding (`npm version` + `npm run build`), you must restart Claude Code so the MCP bridge process loads the new bundle. The bridge holds `CURRENT_VERSION` in memory from session start; a version mismatch with a newly spawned backend causes `ensureBackend()` to loop indefinitely and timeout.

## Why
`ensureBackend()` compares the bridge's in-memory `CURRENT_VERSION` against the backend's `version` field in `backend.json`. If they differ, the bridge shuts down the backend and spawns a replacement — but the replacement also reads the new version from disk, so the mismatch persists. This manifests as "Timed out waiting for Coral backend startup" on every MCP tool call.

## Pattern
Trigger: `backend shutdown` (or crash) after a version bump within the same Claude Code session.

```
# Wrong: bump version, rebuild, then keep using the same session
npm version 0.4.5 --no-git-tag-version && npm run build
# bridge still has CURRENT_VERSION = "0.4.4" in memory
# backend shutdown → new backend spawns as 0.4.5 → mismatch → timeout loop

# Right: restart Claude Code after version bump
npm version 0.4.5 --no-git-tag-version && npm run build
# exit and restart Claude Code
# bridge loads fresh bundle → CURRENT_VERSION = "0.4.5" → matches backend
```

Note: The issue only surfaces after the old backend dies. If the backend stays alive from before the bump (still running the old version), the bridge can still communicate with it. The problem appears when a new backend is spawned from the updated disk bundle.
