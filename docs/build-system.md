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

```javascript
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync } from 'fs';

mkdirSync('bridge', { recursive: true });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

await esbuild.build({
  entryPoints: ['src/mcp/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'bridge/coral-server.cjs',
  packages: 'external',
  define: {
    '__VERSION__': JSON.stringify(version),
  },
});
```

### esbuild Settings

| Setting | Value | Reason |
|---|---|---|
| `entryPoints` | `src/mcp/server.ts` | MCP server entry point (TypeScript direct input) |
| `bundle` | `true` | Bundle all dependencies into a single file |
| `platform` | `node` | Target Node.js environment |
| `target` | `node18` | Generate Node 18+ compatible code |
| `format` | `cjs` | CommonJS format (matches `.cjs` extension) |
| `outfile` | `bridge/coral-server.cjs` | Bundle output path |
| `packages` | `external` | Exclude all npm packages from bundle (resolved from `node_modules` at runtime) |
| `define` | `{ '__VERSION__': ... }` | Inject package.json version at build time |

### packages: 'external'

The `packages: 'external'` setting excludes all npm packages (`@modelcontextprotocol/sdk`, `zod`, etc.) from the bundle. Node.js built-in modules are automatically externalized when `platform: 'node'`.

### Version Injection

The `version` field is read from `package.json` and injected as the `__VERSION__` constant at build time. Used during MCP server initialization in `server.ts`:

```typescript
declare const __VERSION__: string;
// ...
new Server({ name: 'coral', version: __VERSION__ }, ...)
```

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
    "coral": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bridge/coral-server.cjs"]
    }
  }
}
```

Claude Code runs `node bridge/coral-server.cjs` to start the MCP server via stdio. `CLAUDE_PLUGIN_ROOT` is auto-replaced with the plugin root directory.
