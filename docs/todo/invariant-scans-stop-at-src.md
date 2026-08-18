# TODO — two invariant scans stop at `src/`, and the hook lane is where the bugs were

**Status**: open, half-closed. One of the two scans was extended and found nothing; the other cannot be
extended without teaching its detector a second idiom, and that is the work this entry holds.

## What exists

`tests/invariants/sync-subprocess-timeout.test.ts` was extended to `clients/hooks/**/*.mjs` on 2026-08-18.
It found four hook files with synchronous subprocess calls — `hook-utils.mjs`, `live-work-registry.mjs`,
`project-ignore.mjs`, `session-start.mjs` — all already bounded. No violations, and the lane with the hardest
deadline (a 5s hook budget, no event loop to interrupt a blocking child) is now scanned.

`tests/invariants/flavor-path-separation.test.ts` still sets its root to `src/` only. That is the scan whose
blind spot let `coralProjectDir` hard-code `projects` for both build flavors — the hook lane read the prod
tree while the daemon wrote `projects-dev`, and the invariant that enforces the separation "uniformly" could
not see it. The fix landed; the scan did not move.

## Why extending it is not mechanical

Three hook files — `equip-tools.mjs`, `pre-compact.mjs`, `session-start.mjs` — route through the generation
directory with `'gen2'` as a literal sibling argument (`join(stateRoot, 'gen2', dataDir, …)`) because they
cannot import `generationRoot()` from `src/`. The current detector recognises only the `src/` idiom, so
extending the scan as-is reports all three as violations. Making it correct means the detector accepts a
second, structurally different spelling of the same rule — a real logic change, not a root-list edit.

That is worth doing carefully rather than quickly: a scan that must be taught one exception per caller stops
being an invariant and becomes a list, and the next hook file to hard-code a flavored path will be added to
the list rather than caught by it.

## Required shape

Teach the detector both idioms — the imported `generationRoot()`/`projectsPaths()` call and the literal
segment join — and assert that any hook-lane path under `~/.coral` carrying a flavored family name derives
its flavor rather than naming one. Then extend the root list to match
`tests/invariants/cited-symbol-homes.test.ts`, which already scans `src`, `tests`, `tools`, `clients/hooks`,
`clients/skills`, `docs` and `.claude`.

## What would have to be true to start

Nothing external. The measurement is already done and recorded above: three files, one alternate idiom.
