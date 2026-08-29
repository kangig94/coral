# TODO — nine `src/` files import `src/` through `#src/`, and the emitted `dist/` cannot be loaded

**Status**: open, not started. The reproduction and the file list are below; the work is one invariant plus
nine import rewrites.

## What exists

`package.json` maps `"#src/*.js": "./src/*.ts"` before `"#src/*": "./src/*"`. That alias exists so `tests/`,
`tools/` and `vitest/` can name source modules by a stable path while running TypeScript directly.

Nine files under `src/` use it to import other files under `src/`:

`engines/kiwi/analyzer-manager.ts`, `engines/kiwi/model-artifact.ts`, `engines/gemini/expansion.ts`,
`engines/onnx/expansion.ts`, `engines/orama/expansion.ts`, `expansion/bundled.ts`, `recovery/containment.ts`,
`infra/store-reset-inspection-fs.ts`, `infra/store-reset-diagnostic-supervisor.ts`.

Every other file in `src/` uses a relative specifier.

`tsc` does not rewrite module specifiers, so seven emitted artifacts carry the alias into `dist/`
(the last two files import types only, which are erased). Loading one of those artifacts as an ES module
sends Node back out of `dist/` and into `src/`:

`dist/recovery/containment.js` → `#src/infra/error-format.js` → the imports map → `src/infra/error-format.ts`
→ Node loads that TypeScript file and resolves its relative `./json.js` literally → `src/infra/json.js` does
not exist, only `json.ts` → `ERR_MODULE_NOT_FOUND`.

## Who this reaches

Production is unaffected: `clients/build/*.cjs` are esbuild bundles, and esbuild resolves the alias at bundle
time. `dist/` is a `tsc` emit that nothing ships.

The one consumer that loads `dist/**` as modules is `scripts/capture-discuss-golden-master.mjs`, which imports
`dist/discuss/shell/operations.js` and `dist/discuss/shell/persistence.js` directly. It cannot run: it dies at
link time on the chain above, before reaching anything it was written to capture. Observed 2026-08-30. That
script is not referenced by `package.json`, CI, or any document, which is why the breakage has gone unnoticed.

## Why the fix is on the import, not on the script

Bundling the two `dist/` entries in the capture script would make that one tool work and leave `dist/` a
build output that cannot be loaded — a property nobody would expect and nothing states. The alias is
test-side vocabulary; `src/` importing itself through it is the anomaly, and it is the anomaly in nine files
against the rest of the tree.

Rewrite those nine imports as relative, and add an invariant that no file under `src/` imports `#src/`.
The invariant is what makes the ninth file the last one, and it is cheap: a specifier-prefix check on the
existing source scan.

## Out of scope

Whether `dist/` should exist at all, and whether the capture script should be deleted rather than repaired.
Both are real questions and neither has to be answered to stop `src/` from depending on a test alias. The
capture script's own second defect — it reaches a checked test database door and needs a tier stamped, which
it now has — is already fixed and is not this entry.

## Start condition

Startable now. Nothing depends on the current shape, and the invariant is what keeps the list from growing
back.
