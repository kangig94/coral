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

The `bridge/coral-server.cjs` bundle is committed to the repository. This means users can use the plugin by pointing to the plugin directory without running `npm install` + `npm run build`:

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
    v  esbuild (bundling)
bridge/coral-server.cjs
```

### Step 1: TypeScript Compilation

`tsc` compiles all `.ts` files under `src/`.

**Key tsconfig.json settings:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  }
}
```

| Setting | Value | Reason |
|---|---|---|
| `target` | ES2022 | Use Node 18+ features (top-level await, etc.) |
| `module` | NodeNext | ESM + `.js` extension import support |
| `strict` | true | Maximum type safety |
| `declaration` | true | Generate `.d.ts` files (for library usage) |

### Step 2: esbuild Bundling

`scripts/build-server.mjs` runs esbuild to produce a single CJS bundle.

**File**: `scripts/build-server.mjs`

The build script performs two tasks: version sync and esbuild bundling.

### Version Sync

`package.json` is the single source of truth for the version. On each build, the script syncs the version to `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` automatically.

### esbuild Settings

| Setting | Value | Reason |
|---|---|---|
| `entryPoints` | `src/mcp/server.ts` | MCP server entry point (TypeScript direct input) |
| `bundle` | `true` | Bundle all dependencies into a single file |
| `platform` | `node` | Target Node.js environment |
| `target` | `node18` | Generate Node 18+ compatible code |
| `format` | `cjs` | CommonJS format (matches `.cjs` extension) |
| `outfile` | `bridge/coral-server.cjs` | Bundle output path |
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

**vitest.config.ts:**

```typescript
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

## Connection to .mcp.json

```json
{
  "mcpServers": {
    "cx": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bridge/coral-server.cjs"]
    }
  }
}
```

Claude Code runs `node bridge/coral-server.cjs` to start the MCP server via stdio. `CLAUDE_PLUGIN_ROOT` is auto-replaced with the plugin root directory.
