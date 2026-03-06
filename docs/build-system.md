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

All three bundles (`bridge/coral-ax.cjs`, `bridge/coral-discuss.cjs`, and `bridge/coral-backend.cjs`) are committed to the repository. This means users can use the plugin by pointing to the plugin directory without running `npm install` + `npm run build`:

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
bridge/coral-discuss.cjs   (src/discuss/server.ts)
bridge/coral-backend.cjs   (src/execution/server.ts)
```

### Step 1: TypeScript Compilation

`tsc` compiles all `.ts` files under `src/`. ES2022 for Node 18+, NodeNext for ESM, strict mode. See `tsconfig.json`.

### Step 2: esbuild Bundling

`scripts/build-server.mjs` runs esbuild to produce three CJS bundles — two MCP servers and one HTTP backend daemon.

The build script performs two tasks before bundling: version sync and manifest update.

### Version Sync

`package.json` is the single source of truth for the version. On each build, the script reads `package.json`, then writes the `version` field into `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` automatically. No manual version updates needed in those files.

### esbuild Settings

| Setting | Value | Reason |
|---|---|---|
| `entryPoints` | `src/bridge/server.ts`, `src/discuss/server.ts`, `src/execution/server.ts` | Three entry points (two MCP servers + HTTP backend daemon) |
| `bundle` | `true` | Bundle all dependencies into a single file |
| `platform` | `node` | Target Node.js environment |
| `target` | `node18` | Generate Node 18+ compatible code |
| `format` | `cjs` | CommonJS format (matches `.cjs` extension) |
| `outfile` | `bridge/coral-ax.cjs`, `bridge/coral-discuss.cjs`, `bridge/coral-backend.cjs` | Bundle output paths |
| `external` | `['node:*']` | Externalize Node.js built-in modules |
| `minify` | `true` | Minimize bundle size |
| `banner` | `var __PLUGIN_ROOT__=...` | Resolve plugin root at runtime via CJS `__dirname` |
| `define` | `{ '__VERSION__': ... }` | Inject package.json version at build time. Backend bundle also defines `__IS_CORAL_BACKEND_MAIN__` |

### Build-time Injections

| Constant | Source | Usage |
|---|---|---|
| `__VERSION__` | `package.json` version | MCP server initialization (`server.ts`) |
| `__PLUGIN_ROOT__` | CJS `__dirname` + `..` | Runtime plugin-root resolution for shared resolver + Codex CLAUDE.md injection |
| `__IS_CORAL_BACKEND_MAIN__` | `true` (backend bundle only) | Guards auto-start logic in `src/execution/server.ts` |

`__PLUGIN_ROOT__` is a CJS banner variable (not a `define` replacement), set to `path.resolve(__dirname, '..')` at runtime. This allows the bundled server to locate `CLAUDE.md` regardless of where the plugin is installed.

## Testing

Run tests with vitest:

```bash
npm test
```

Tests live in `src/bridge/__tests__/`, `src/execution/__tests__/`, `src/providers/__tests__/`, `src/providers/codex/__tests__/`, `src/providers/claude/__tests__/`, `src/coral/__tests__/`, `src/shared/__tests__/`, `src/workflow/__tests__/`, and `src/discuss/__tests__/`. See `vitest.config.ts`.

One test file per source module. External dependencies (Codex CLI, filesystem) are mocked — real Codex is never called in tests.

## Connection to .mcp.json

Claude Code runs both MCP servers via stdio. The `ax` server runs `bridge/coral-ax.cjs`, which proxies to the backend daemon (`bridge/coral-backend.cjs`) for Codex + Claude CLI tools (`codex` and `claude`). The `dc` server runs `bridge/coral-discuss.cjs` for discuss tools (`discuss` and `discuss_lead`). `CLAUDE_PLUGIN_ROOT` in `.mcp.json` is auto-replaced with the plugin root directory at registration time.
