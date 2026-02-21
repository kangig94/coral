# Build System

TypeScript compilation and esbuild bundling pipeline.

## Build Commands

| Command | Description |
|---|---|
| `npm run build` | TypeScript compile + esbuild bundle (full build) |
| `npm run build:server` | esbuild bundle only (skips tsc) |
| `npm run dev` | TypeScript watch mode (`tsc --watch`) |
| `npm test` | Run tests with vitest |

## Bundle Commit Policy

Both bundles (`bridge/coral-codex.cjs` and `bridge/coral-discuss.cjs`) are committed to the repository. This means users can use the plugin by pointing to the plugin directory without running `npm install` + `npm run build`:

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
    v  esbuild (bundling, 2 entry points)
bridge/coral-codex.cjs     (src/codex/server.ts)
bridge/coral-discuss.cjs   (src/discuss/server.ts)
```

### Step 1: TypeScript Compilation

`tsc` compiles all `.ts` files under `src/`. ES2022 for Node 18+, NodeNext for ESM, strict mode. See `tsconfig.json`.

### Step 2: esbuild Bundling

`scripts/build-server.mjs` runs esbuild to produce a single CJS bundle.

The build script performs two tasks: version sync and esbuild bundling.

### Version Sync

`package.json` is the single source of truth for the version. On each build, the script syncs the version to `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` automatically.

### esbuild Settings

| Setting | Value | Reason |
|---|---|---|
| `entryPoints` | `src/codex/server.ts`, `src/discuss/server.ts` | Two MCP server entry points (one build per server) |
| `bundle` | `true` | Bundle all dependencies into a single file |
| `platform` | `node` | Target Node.js environment |
| `target` | `node18` | Generate Node 18+ compatible code |
| `format` | `cjs` | CommonJS format (matches `.cjs` extension) |
| `outfile` | `bridge/coral-codex.cjs`, `bridge/coral-discuss.cjs` | Bundle output paths |
| `external` | `['node:*']` | Externalize Node.js built-in modules |
| `minify` | `true` | Minimize bundle size |
| `banner` | `var __PLUGIN_ROOT__=...` | Resolve plugin root at runtime via CJS `__dirname` |
| `define` | `{ '__VERSION__': ... }` | Inject package.json version at build time |

### Build-time Injections

| Constant | Source | Usage |
|---|---|---|
| `__VERSION__` | `package.json` version | MCP server initialization (`server.ts`) |
| `__PLUGIN_ROOT__` | CJS `__dirname` + `..` | Runtime CLAUDE.md file reading for Codex prompt injection (`codex-executor.ts`) |

## Testing

Run tests with vitest:

```bash
npm test
```

Tests live in `src/**/__tests__/`. See `vitest.config.ts`.

## Connection to .mcp.json

Claude Code runs both MCP servers via stdio. `cx` provides Codex CLI tools (`codex_session_*`), `dc` provides discuss tools (`discuss_*`). `CLAUDE_PLUGIN_ROOT` is auto-replaced with the plugin root directory. See `.mcp.json`.
