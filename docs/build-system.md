# Build System

TypeScript compilation and esbuild bundling pipeline.

## Build Commands

| Command | Description |
|---|---|
| `npm run build` | TypeScript compile + esbuild bundle (full build) |
| `npm run build:server` | esbuild bundle only (skips tsc) |
| `npm run dev` | TypeScript watch mode (`tsc --watch`) |
| `npm test` | Run tests with vitest |
| `cmake -B build coral-needle repo (github.com/kangig94/coral-needle) && cmake --build build -j$(($(nproc)/4))` | Build C++ native addon (requires cmake + C++ toolchain) |

## Bundle Commit Policy

All three bundles (`bridge/coral-ax.cjs`, `bridge/coral-backend.cjs`, and `bridge/coral-cli.cjs`) are committed to the repository. This means users can use the plugin by pointing to the plugin directory without running `npm install` + `npm run build`:

```bash
claude --plugin-dir /path/to/coral
```

Rebuild is only needed when source code is modified.

## Build Pipeline

```
src/**/*.ts
    |
    v  tsc (TypeScript compilation)
dist/**/*.js + dist/**/*.d.ts
    |
    v  esbuild (bundling, 3 entry points)
bridge/coral-ax.cjs        (src/bridge/server.ts)
bridge/coral-backend.cjs   (src/execution/server.ts)
bridge/coral-cli.cjs       (src/cli/bootstrap.ts)
```

### Step 1: TypeScript Compilation

`tsc` compiles all `.ts` files under `src/`. ES2022 for Node 18+, NodeNext for ESM, strict mode. See `tsconfig.json`.

### Step 2: esbuild Bundling

`scripts/build-server.mjs` runs esbuild to produce three CJS bundles — one MCP stdio proxy, one HTTP backend daemon, and one CLI client.

The build script performs two tasks before bundling: version sync and manifest update.

### C++ Native Addon (coral-needle repo (github.com/kangig94/coral-needle))

The vector search addon is built separately from the TypeScript pipeline.

```
coral-needle repo (github.com/kangig94/coral-needle)
├── CMakeLists.txt        DuckDB prebuilt download + addon compilation
├── VERSION               Independent version (e.g., 0.1.0)
├── bridge.cpp            N-API entry point
├── store/                DuckDB integration (CRUD)
├── engine/               Search engines (ExactScan, USearch HNSW)
└── vendor/
    ├── VERSIONS           Pinned dependency versions
    ├── duckdb/duckdb.hpp  Header only (prebuilt .a downloaded at configure)
    └── usearch/           Header-only search library
```

**Build**: `cmake -B build coral-needle repo (github.com/kangig94/coral-needle) && cmake --build build --config Release -j$(($(nproc)/4))`

**Output**: `build/coral-vec.node`

**DuckDB**: Prebuilt `libduckdb_static.a` is auto-downloaded from GitHub Releases at cmake configure time. No DuckDB source compilation needed.

**Parallelism**: Always use `-j$(($(nproc)/4))` — full CPU causes freezes with large C++ headers.

**Distribution**: Prebuilt addon binaries are published to GitHub Releases as `coral-needle-v{version}-{platform}.tar.gz`. `/coral:equip kb` downloads the matching prebuild, falling back to source build if unavailable.

**CI**: `.github/workflows/csrc-release.yml` builds 5 platforms on `main` push (coral-needle repo (github.com/kangig94/coral-needle) changes) or `csrc@*` tag push.

### Version Sync

`package.json` is the single source of truth for the version. On each build, the script reads `package.json`, then writes the `version` field into `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` automatically. No manual version updates needed in those files.

### Manifest Update

`bridge/manifest.json` is extended during build to include native addon compatibility metadata: `csrcVersion`, `schemaVersion`, and `minNapiVersion` (sourced from `coral-needle repo (github.com/kangig94/coral-needle)VERSION` and `src/kb/vector-store-contract.ts`). When `coral-needle repo (github.com/kangig94/coral-needle)VERSION` is absent, these fields are `null` so TypeScript-only builds succeed.

### esbuild Settings

| Setting | Value | Reason |
|---|---|---|
| `entryPoints` | `src/bridge/server.ts`, `src/execution/server.ts`, `src/cli/bootstrap.ts` | Three entry points (MCP stdio proxy + HTTP backend daemon + CLI client) |
| `bundle` | `true` | Bundle all dependencies into a single file |
| `platform` | `node` | Target Node.js environment |
| `target` | `node18` | Generate Node 18+ compatible code |
| `format` | `cjs` | CommonJS format (matches `.cjs` extension) |
| `outfile` | `bridge/coral-ax.cjs`, `bridge/coral-backend.cjs`, `bridge/coral-cli.cjs` | Bundle output paths |
| `external` | `['node:*']` | Externalize Node.js built-in modules |
| `minify` | `true` | Minimize bundle size |
| `banner` | `var __PLUGIN_ROOT__=...` | Resolve plugin root at runtime via CJS `__dirname` |
| `define` | `{ '__VERSION__': ... }` | Inject package.json version at build time. Backend bundle also defines `__IS_CORAL_BACKEND_MAIN__` |

### Build-time Injections

| Constant | Source | Usage |
|---|---|---|
| `__VERSION__` | `package.json` version | MCP server initialization (`server.ts`) |
| `__PLUGIN_ROOT__` | CJS `__dirname` + `..` | Runtime plugin-root resolution for shared resolver + Codex INJECT.md injection |
| `__IS_CORAL_BACKEND_MAIN__` | `true` (backend bundle only) | Guards auto-start logic in `src/execution/server.ts` |
| `CORAL_VEC_ADDON_VERSION` | `coral-needle repo (github.com/kangig94/coral-needle)VERSION` | Addon version reported by `getStats()` |
| `CORAL_VEC_SCHEMA_VERSION` | `src/kb/vector-store-contract.ts` | DuckDB schema version for compatibility checks |

`__PLUGIN_ROOT__` is a CJS banner variable (not a `define` replacement), set to `path.resolve(__dirname, '..')` at runtime. This allows the bundled server to locate `INJECT.md` regardless of where the plugin is installed.

## Testing

Run tests with vitest:

```bash
npm test
```

Tests live in `src/bridge/__tests__/`, `src/execution/__tests__/`, `src/providers/__tests__/`, `src/providers/codex/__tests__/`, `src/providers/claude/__tests__/`, `src/shared/__tests__/`, `src/workflow/__tests__/`, `src/kb/__tests__/`, and `src/discuss/__tests__/`. See `vitest.config.ts`.

One test file per source module. External dependencies (Codex CLI, filesystem) are mocked — real Codex is never called in tests.

## Connection to .mcp.json

Claude Code runs the `ax` MCP server via stdio (`bridge/coral-ax.cjs`), which proxies to the backend daemon (`bridge/coral-backend.cjs`) for all tools including Codex, Claude CLI, and discuss. `CLAUDE_PLUGIN_ROOT` in `.mcp.json` is auto-replaced with the plugin root directory at registration time.
