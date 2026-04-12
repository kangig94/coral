# Build System

TypeScript compilation plus esbuild bundling for the current Coral runtime, with explicit prod and dev flavor builds.

## Build Commands

| Command | Description |
| --- | --- |
| `npm run build` | TypeScript compile plus esbuild bundle (prod flavor) |
| `npm run build:dev` | TypeScript compile plus esbuild bundle (dev flavor) |
| `npm run build:server` | esbuild bundle only (prod flavor) |
| `npm run dev` | TypeScript watch mode |
| `npm test` | Run the test suite |

## Build Flavors

`scripts/build-server.mjs` accepts `--flavor prod|dev`. `npm run build` and `npm run build:server` pass `--flavor prod`, `npm run build:dev` passes `--flavor dev`, and omitting the flag defaults to `prod`. Flavor is selected explicitly by the build command, not inferred from `NODE_ENV`.

The bundle code is identical across flavors; the distinction lives in `bridge/manifest.json`, which carries both `bundleHash` and `flavor`. See `docs/dev-setup.md` for parallel dev/prod daemon usage.

## Bundle Commit Policy

The committed runtime bundles are:

- `bridge/coral-backend.cjs`
- `bridge/coral-cli.cjs`
- `bridge/coral-claude-appserver.cjs`
- `bridge/manifest.json`

Users can point Claude Code at the plugin directory without a local rebuild, but source changes still require `npm run build`. A local `npm run build:dev` rewrites the same bridge outputs with a dev-flavored manifest for coexistence testing.

## Build Pipeline

```text
src/**/*.ts
  │
  ▼  tsc
dist/**/*.js + dist/**/*.d.ts
  │
  ▼  esbuild (`scripts/build-server.mjs`)
bridge/coral-backend.cjs
bridge/coral-cli.cjs
bridge/coral-claude-appserver.cjs
bridge/manifest.json (`{ "bundleHash", "flavor" }`)
```

The runtime is anchored by two primary entry points:

| Entry point | Output | Role |
| --- | --- | --- |
| `src/execution/server.ts` | `bridge/coral-backend.cjs` | Backend daemon |
| `src/cli/bootstrap.ts` | `bridge/coral-cli.cjs` | CLI entrypoint |

The build script also emits `bridge/coral-claude-appserver.cjs` from `src/providers/claude-appserver/server.ts` for the Claude appserver helper runtime.

## Build Script Responsibilities

`scripts/build-server.mjs` does four things:

1. Reads `package.json` as the single source of truth for the version.
2. Syncs that version into `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
3. Bundles the backend, CLI, and Claude appserver helper.
4. Rewrites `bridge/manifest.json` atomically with `{ bundleHash, flavor }` for change detection and flavor identity.

`bundleHash` remains the content hash of `bridge/coral-backend.cjs`. Flavor is stored and compared separately, so a same-byte prod/dev pair still forces replacement when the flavor changes.

## esbuild Settings

| Setting | Value | Reason |
| --- | --- | --- |
| `bundle` | `true` | Single-file deployable bundles |
| `platform` | `node` | Node.js runtime target |
| `target` | `node18` | Matches the supported runtime floor |
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
| `CORAL_VEC_SCHEMA_VERSION` | `src/kb/vector-store-contract.ts` | Vector-store compatibility checks |

Build flavor is intentionally not injected through an esbuild define. Hooks are unbundled ESM files, so the shared carrier is `bridge/manifest.json`.

## Dependencies

The build and runtime no longer depend on `@modelcontextprotocol/sdk`. Current package-managed runtime concerns are ordinary Node/TypeScript concerns: `zod` for schema validation, `esbuild` for bundling, and the Coral runtime packages declared in `package.json`.

## Testing

Tests run with:

```bash
npm test
```

The suites cover CLI routing, client helpers, backend handlers, providers, workflow execution, KB behavior, discuss behavior, and shared contracts.

## Claude Code Integration

Claude Code reaches Coral through the plugin directory, hooks, and Bash-invoked `coral-cli`. There is no separate server-registration file and no stdio proxy bundle in the build.
