# Client Subpath Exports Need Publish Metadata and Runtime Artifacts
Promoted: 2026-03-10 | Updated: 2026-03-13
## Rule
When publishing a package subpath like `coral/client`, do not stop at `package.json.exports`. Verify the packed artifact actually contains the referenced `dist/` files and any runtime artifacts the client depends on. In repos where `npm pack` inherits `.gitignore`, add `files` (or equivalent publish metadata) so `dist/` is shipped, and if the exported client starts local binaries, package those binaries, manifests, and any data files they resolve at runtime. For Coral CLI parity, that can include `agents/`, `skills/`, and `INJECT.md`, not just bridge bundles. For Node ESM clients, path resolution must be `import.meta.url`-safe rather than `__dirname`-based.
## Why
An export map can look correct in-source while the published tarball omits `dist/` entirely, making the subpath fail only after packing or installation. Lifecycle helpers are especially fragile: if they still assume in-repo paths or bundled globals, the exported client imports fine in TypeScript but throws at runtime. Coral-style CLIs have an additional trap: `coral:*` dispatch and one-shot Codex prep both read package-root assets, so a bundle that ships only JavaScript files silently diverges from in-repo behavior.
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
    "bridge/manifest.json",
    "agents/**",
    "skills/**",
    "INJECT.md"
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
published CLI omits agents/skills/INJECT.md even though runtime resolves them
```
