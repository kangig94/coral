# Execution Generated Bridge Rebuild For Symbol Checks
Promoted: 2026-03-12 | Updated: 2026-03-12
## Rule
When acceptance checks depend on repository-wide symbol searches for execution code, rebuild the generated bridge bundles after patching source files. `bridge/coral-backend.cjs` can retain stale compiled manager code, so source-only edits are not enough for zero-reference verification.
## Why
Search-based checks can report removed symbols such as `watchTail` or old method signatures from the generated bundle even when `src/` is already correct. That creates false negatives during verification and makes it look like the implementation is incomplete when the only missing step is regenerating the bridge output.
## Pattern
```sh
npm run build
rg -n "watchTail|WATCH_TAIL_LIMIT|loadWatchHistory" src bridge
```

```sh
# Wrong: verifies source only, leaves stale compiled output in bridge/
rg -n "watchTail|WATCH_TAIL_LIMIT|loadWatchHistory" src bridge
```
