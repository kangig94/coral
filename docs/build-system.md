# Build System

TypeScript compilation plus esbuild bundling for the current Coral runtime.

## Build Commands

| Command | Description |
| --- | --- |
| `npm run build` | TypeScript compile plus esbuild bundle |
| `npm run build:server` | esbuild bundle only |
| `npm run dev` | TypeScript watch mode |
| `npm test` | Run the test suite |

## Bundle Commit Policy

The committed runtime bundles are:

- `bridge/coral-backend.cjs`
- `bridge/coral-cli.cjs`
- `bridge/coral-claude-appserver.cjs`
- `bridge/manifest.json`

Users can point Claude Code at the plugin directory without a local rebuild, but source changes still require `npm run build`.

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
bridge/manifest.json
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
4. Rewrites `bridge/manifest.json` with the backend bundle hash for change detection.

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
