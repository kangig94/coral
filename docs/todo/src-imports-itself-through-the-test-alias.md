# TODO — nine `src/` files import `src/` through `#src/`, and the emitted `dist/` cannot be loaded

**Status**: open, not started. The reproduction and the file list are below; the work is one invariant plus
nine static import rewrites.

## What exists

`package.json` maps `"#src/*.js": "./src/*.ts"` before `"#src/*": "./src/*"`. That alias exists so `tests/`,
`tools/` and `vitest/` can name source modules by a stable path while running TypeScript directly.

Nine files under `src/` use it to import other files under `src/`:

`engines/kiwi/analyzer-manager.ts`, `engines/kiwi/model-artifact.ts`, `engines/gemini/expansion.ts`,
`engines/onnx/expansion.ts`, `engines/orama/expansion.ts`, `expansion/bundled.ts`, `recovery/containment.ts`,
`infra/store-reset-inspection-fs.ts`, `infra/store-reset-diagnostic-supervisor.ts`.

Every other file in `src/` uses a relative specifier.

`src/expansion/bundled.ts` also carries `#src/engines/gemini/expansion.js` and
`#src/engines/onnx/expansion.js` as runtime manifest string values consumed by
`await import(entry.specifier)`. They are not import declarations and are not part of the nine rewrites.

`tsc` does not rewrite module specifiers, so seven emitted artifacts carry the alias into `dist/`
(the last two files import types only, which are erased). Loading one of those artifacts as an ES module
sends Node back out of `dist/` and into `src/`:

`dist/recovery/containment.js` → `#src/infra/error-format.js` → the imports map → `src/infra/error-format.ts`
→ Node loads that TypeScript file and resolves its relative `./json.js` literally → `src/infra/json.js` does
not exist, only `json.ts` → `ERR_MODULE_NOT_FOUND`.

## Who this reaches

The bundled production entry points are unaffected: `clients/build/*.cjs` are esbuild bundles, and esbuild
resolves the alias at bundle time. `dist/` is also listed in `package.json`'s `files` array, so it ships in
the npm package; the failure is specifically that the affected `dist/**` files cannot be loaded as ES
modules.

The only repository consumer that loads the affected discuss artifacts from `dist/**` as ES modules is
`scripts/capture-discuss-golden-master.mjs`, which imports `dist/discuss/shell/operations.js` and
`dist/discuss/shell/persistence.js` directly. It cannot run: it dies at link time on the chain above, before
reaching anything it was written to capture. Observed 2026-08-30. That script is not wired into
`package.json` or CI, so nothing executes it automatically.

## Why the fix is on the import, not on the script

Bundling the two `dist/` entries in the capture script would make that one tool work and leave `dist/` a
build output that cannot be loaded — a property nobody would expect and nothing states. The alias is
test-side vocabulary; `src/` importing itself through it is the anomaly, and it is the anomaly in nine files
against the rest of the tree.

Rewrite those nine static imports as relative, and add an invariant that no static import, `export … from`,
or literal dynamic-import specifier under `src/` begins with `#src/`. The invariant deliberately does not
scan arbitrary string values, so the Gemini and ONNX manifest specifiers remain unchanged.

That distinction is load-bearing: `loadBundledEngine` passes those manifest values to
`await import(entry.specifier)`, while the `BUNDLED_LOADERS` constraint in `src/expansion/bundled.ts`
documents the resolution hazard and says a marketplace install ships `src/` beside the bundle. Measured on
2026-08-30, both layouts exist side by side on one machine: `~/.claude/plugins/cache/coral/coral/0.10.9/`
holds only the flattened `clients/` contents and has neither `src/` nor a `package.json` imports map, while
`~/.claude/plugins/marketplaces/coral/` is a full clone of the release tag and has both. Which one resolves
the specifier depends on where the running backend was launched from, so the comment is true of one layout
and false of the other. The manifest strings
remain unchanged by this TODO; resolving their viable installed target requires a separate design. A
raw-text ban on every `#src/` string is therefore not the invariant proposed here.

## Out of scope

Whether `dist/` should exist at all, and whether the capture script should be deleted rather than repaired.
Both are real questions and neither has to be answered to stop `src/` from depending on a test alias. The
capture script's own second defect — it reaches a checked test database door and needs a tier stamped, which
it now has — is already fixed and is not this entry.

## Start condition

Startable now. Nothing depends on the current shape, and the invariant is what keeps the list from growing
back.
