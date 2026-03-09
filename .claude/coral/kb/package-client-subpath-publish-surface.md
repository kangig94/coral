# Client Subpath Exports Need Publish Metadata and Runtime Artifacts
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
When publishing a package subpath like `coral/client`, do not stop at `package.json.exports`. Verify the packed artifact actually contains the referenced `dist/` files and any runtime artifacts the client depends on. In repos where `npm pack` inherits `.gitignore`, add `files` (or equivalent publish metadata) so `dist/` is shipped, and if the exported client starts local binaries, package those binaries and manifests too. For Node ESM clients, path resolution must be `import.meta.url`-safe rather than `__dirname`-based.
## Why
An export map can look correct in-source while the published tarball omits `dist/` entirely, making the subpath fail only after packing or installation. Lifecycle helpers are especially fragile: if they still assume in-repo paths or bundled globals, the exported client imports fine in TypeScript but throws at runtime.
## Pattern
Right:
```json
{
  "exports": {
    "./client": "./dist/client/index.js"
  },
  "files": [
    "dist/**",
    "bridge/coral-backend.cjs",
    "bridge/manifest.json"
  ]
}
```

```typescript
const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
```

Wrong:
```json
{
  "exports": {
    "./client": "./dist/client/index.js"
  }
}
```

```text
.gitignore still excludes dist/
client runtime still relies on __dirname or in-repo bridge paths
```
