# Build System

TypeScript compilation plus esbuild bundling for the current Coral runtime, with explicit prod and dev flavor builds.

## Build Commands

| Command | Description |
| --- | --- |
| `npm run clean:dist` | Remove `dist/` so deleted source paths cannot survive in package output |
| `npm run build` | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle to `clients/build/` (prod flavor) |
| `npm run build:dev` | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle to `clients/build/` (dev flavor) |
| `npm run build:release` | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle (prod), then copy `clients/build/` to `clients/bridge/` |
| `npm run check:simulation` | Typecheck `tools/simulation` against `src` and verify sealing |
| `npm run simulate -- tools/simulation/scenarios/<scenario.yaml>` | Run the debug-only simulation harness |
| `npm run dev` | TypeScript watch mode |
| `npm test` | Run the test suite |

## Build Flavors

`scripts/build-server.mjs` accepts `--flavor prod|dev` and `--release`. `npm run build` passes `--flavor prod`, `npm run build:dev` passes `--flavor dev`, and `npm run build:release` passes `--flavor prod --release`. Omitting `--flavor` defaults to `prod`. Flavor is selected explicitly by the build command, not inferred from `NODE_ENV`.

The bundle code is identical across flavors; the distinction lives in `manifest.json`, which carries both `bundleHash` and `flavor`. See `docs/dev-setup.md` for parallel dev/prod daemon usage.

## Build Output and Bridge

Build output goes to `clients/build/` (git-ignored). The committed runtime bundles in `clients/bridge/` are rebuilt by `npm run build:release` and are refreshed on `main` only by the **Release** workflow (`.github/workflows/release.yml`) — not in feature PRs. The committed bundles are:

- `clients/bridge/coral-backend.cjs`
- `clients/bridge/coral-cli.cjs`
- `clients/bridge/coral-claude-appserver.cjs`
- `clients/bridge/manifest.json`

`clients/bridge/` is not checked per-PR: PR CI (`.github/workflows/ci.yml`) only builds and tests. `clients/bridge/` is regenerated for the exact version and committed by the Release workflow at release time, so each release **tag** carries the matching bundles (the plugin installs from tags). Between releases, `clients/bridge/` on `main` is the previous release's build — expected and harmless, since installs never come from `main`'s HEAD.

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
clients/build/coral-backend.cjs
clients/build/coral-cli.cjs
clients/build/coral-claude-appserver.cjs
clients/build/manifest.json (`{ "bundleHash", "flavor" }`)
  │
  ▼  --release (copy to clients/bridge/)
clients/bridge/*
```

The runtime is anchored by two primary entry points:

| Entry point | Output | Role |
| --- | --- | --- |
| `src/coordinator/bootstrap.ts` | `clients/build/coral-backend.cjs` | Backend daemon |
| `src/cli/bootstrap.ts` | `clients/build/coral-cli.cjs` | CLI entrypoint |

The build script also emits `clients/build/coral-claude-appserver.cjs` from `src/providers/claude/appserver/server.ts` for the Claude broker helper runtime. The filename is retained for bridge compatibility; the helper defaults to `claude -p` stream-json and can use the PTY TUI transport when `CORAL_CLAUDE_TRANSPORT=tui`.

## Build Script Responsibilities

The npm build commands run `scripts/clean-dist.mjs` before `tsc`. TypeScript
does not delete outputs for source files that were removed or moved, so cleaning
`dist/` before compile is required for `package.json`'s `dist/` export to match
the current `src/` tree.

`scripts/build-server.mjs` does five things:

1. Runs simulation compatibility verification (`check-simulation.mjs`), which typechecks `tools/simulation` against `src` and verifies sealing.
2. Reads `package.json` as the single source of truth for the version.
3. Syncs that version into `clients/.claude-plugin/plugin.json`, `clients/.codex-plugin/plugin.json`, and the root `.claude-plugin/marketplace.json`.
4. Bundles the backend, CLI, and Claude broker helper to `clients/build/`.
5. Rewrites `clients/build/manifest.json` atomically with `{ bundleHash, flavor }` for change detection and flavor identity.

When `--release` is passed, it additionally copies all artifacts from `clients/build/` to `clients/bridge/`.

`bundleHash` remains the content hash of `clients/build/coral-backend.cjs`. Flavor is stored and compared separately, so a same-byte prod/dev pair still forces replacement when the flavor changes.

## esbuild Settings

| Setting | Value | Reason |
| --- | --- | --- |
| `bundle` | `true` | Single-file deployable bundles |
| `platform` | `node` | Node.js runtime target |
| `target` | `node22` | Matches the supported runtime floor |
| `format` | `cjs` | Bundles are committed as `.cjs` |
| `external` | `['node:*', '@lydell/node-pty']` | Keep Node built-ins and native modules external (the store uses the built-in `node:sqlite`, so no `better-sqlite3`) |
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

Build flavor is intentionally not injected through an esbuild define. Hooks are unbundled ESM files, so the shared carrier is `clients/bridge/manifest.json`.

## Dependencies

The build and runtime no longer depend on `@modelcontextprotocol/sdk`. Current package-managed runtime concerns are ordinary Node/TypeScript concerns: `zod` for schema validation, `esbuild` for bundling, native runtime packages such as `@lydell/node-pty` (prebuilt-binary fork — ships per-platform `.node` via optional dependencies, so install needs no native toolchain or lifecycle scripts), and the Coral runtime packages declared in `package.json`.

## Testing

Tests run with:

```bash
npm test
```

The suites cover CLI routing, client helpers, backend handlers, providers, workflow execution, KB behavior, discuss behavior, shared contracts, and the debug-only simulation harness. `npm run test:simulation` is only a narrower single-batch shortcut for that harness.

## Release Notes

The **Release** workflow creates the GitHub release with `gh release create --generate-notes`, which builds the release body automatically from every PR merged since the previous release. GitHub's generator is **PR- and label-based** — it uses PR titles for the entries and groups them by label; it does **not** parse commit-message prefixes. Categories are defined in [`.github/release.yml`](../.github/release.yml), and the "one type label per PR" rule plus the label↔prefix mapping live in [`.claude/rules/conventions.md` § PR Labels](../.claude/rules/conventions.md). An unlabeled PR falls under "Other Changes"; the `ignore-for-release` label omits a PR entirely.

## Claude Code Integration

Claude Code reaches Coral through the plugin directory, hooks, and Bash-invoked `coral-cli`. There is no separate server-registration file and no stdio proxy bundle in the build.
