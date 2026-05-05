# Build System

TypeScript compilation plus esbuild bundling for the current Coral runtime, with explicit prod and dev flavor builds.

## Build Commands

| Command | Description |
| --- | --- |
| `npm run clean:dist` | Remove `dist/` so deleted source paths cannot survive in package output |
| `npm run build` | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle to `build/` (prod flavor) |
| `npm run build:dev` | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle to `build/` (dev flavor) |
| `npm run build:release` | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle (prod), then copy `build/` to `bridge/` |
| `npm run check:simulation` | Typecheck `tools/simulation` against `src` and verify sealing |
| `npm run simulate -- tools/simulation/scenarios/<scenario.yaml>` | Run the debug-only simulation harness |
| `npm run dev` | TypeScript watch mode |
| `npm test` | Run the test suite |

## Build Flavors

`scripts/build-server.mjs` accepts `--flavor prod|dev` and `--release`. `npm run build` passes `--flavor prod`, `npm run build:dev` passes `--flavor dev`, and `npm run build:release` passes `--flavor prod --release`. Omitting `--flavor` defaults to `prod`. Flavor is selected explicitly by the build command, not inferred from `NODE_ENV`.

The bundle code is identical across flavors; the distinction lives in `manifest.json`, which carries both `bundleHash` and `flavor`. See `docs/dev-setup.md` for parallel dev/prod daemon usage.

## Build Output and Bridge

Build output goes to `build/` (git-ignored). The committed runtime bundles in `bridge/` are updated only by `npm run build:release`:

- `bridge/coral-backend.cjs`
- `bridge/coral-cli.cjs`
- `bridge/coral-claude-appserver.cjs`
- `bridge/manifest.json`

CI verifies that committed `bridge/` files match a fresh build via hash comparison (see `.github/workflows/verify-bridge.yml`).

## Build Pipeline

```text
src/**/*.ts
  │
  ▼  clean:dist (`scripts/clean-dist.mjs`)
dist/ removed
  │
  ▼  tsc
dist/**/*.js + dist/**/*.d.ts
  │
  ▼  check:simulation (`tsc -p tsconfig/simulation.json` + sealing)
  │
  ▼  esbuild (`scripts/build-server.mjs`)
build/coral-backend.cjs
build/coral-cli.cjs
build/coral-claude-appserver.cjs
build/manifest.json (`{ "bundleHash", "flavor" }`)
  │
  ▼  --release (copy to bridge/)
bridge/*
```

The runtime is anchored by two primary entry points:

| Entry point | Output | Role |
| --- | --- | --- |
| `src/coordinator/bootstrap.ts` | `build/coral-backend.cjs` | Backend daemon |
| `src/cli/bootstrap.ts` | `build/coral-cli.cjs` | CLI entrypoint |

The build script also emits `build/coral-claude-appserver.cjs` from `src/providers/claude-appserver/server.ts` for the Claude appserver helper runtime.

## Build Script Responsibilities

The npm build commands run `scripts/clean-dist.mjs` before `tsc`. TypeScript
does not delete outputs for source files that were removed or moved, so cleaning
`dist/` before compile is required for `package.json`'s `dist/` export to match
the current `src/` tree.

`scripts/build-server.mjs` does five things:

1. Runs simulation compatibility verification (`check-simulation.mjs`), which typechecks `tools/simulation` against `src` and verifies sealing.
2. Reads `package.json` as the single source of truth for the version.
3. Syncs that version into `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
4. Bundles the backend, CLI, and Claude appserver helper to `build/`.
5. Rewrites `build/manifest.json` atomically with `{ bundleHash, flavor }` for change detection and flavor identity.

When `--release` is passed, it additionally copies all artifacts from `build/` to `bridge/`.

`bundleHash` remains the content hash of `build/coral-backend.cjs`. Flavor is stored and compared separately, so a same-byte prod/dev pair still forces replacement when the flavor changes.

## esbuild Settings

| Setting | Value | Reason |
| --- | --- | --- |
| `bundle` | `true` | Single-file deployable bundles |
| `platform` | `node` | Node.js runtime target |
| `target` | `node22` | Matches the supported runtime floor |
| `format` | `cjs` | Bundles are committed as `.cjs` |
| `external` | `['node:*']` | Keep Node built-ins external |
| `minify` | `true` | Smaller committed bundles |
| `banner` | `var __PLUGIN_ROOT__=...` | Runtime plugin-root discovery |
| `define.__VERSION__` | `package.json` version | Shared build-time version injection |
| `define.__IS_CORAL_BACKEND_MAIN__` | backend bundle only | Guards backend auto-start behavior |

## Build-time Injections

| Constant | Source | Usage |
| --- | --- | --- |
| `__VERSION__` | `package.json` | Backend health/version output and CLI version reporting |
| `__PLUGIN_ROOT__` | CJS banner using `__dirname` | Resolve plugin-relative assets at runtime |
| `__IS_CORAL_BACKEND_MAIN__` | build script | Backend main-entry guard |
| `CORAL_VEC_ADDON_VERSION` | coral-needle release metadata | KB addon reporting |

Build flavor is intentionally not injected through an esbuild define. Hooks are unbundled ESM files, so the shared carrier is `bridge/manifest.json`.

## Dependencies

The build and runtime no longer depend on `@modelcontextprotocol/sdk`. Current package-managed runtime concerns are ordinary Node/TypeScript concerns: `zod` for schema validation, `esbuild` for bundling, and the Coral runtime packages declared in `package.json`.

## Testing

Tests run with:

```bash
npm test
```

The suites cover CLI routing, client helpers, backend handlers, providers, workflow execution, KB behavior, discuss behavior, shared contracts, and the debug-only simulation harness. `npm run test:simulation` is only a narrower single-batch shortcut for that harness.

## Claude Code Integration

Claude Code reaches Coral through the plugin directory, hooks, and Bash-invoked `coral-cli`. There is no separate server-registration file and no stdio proxy bundle in the build.
