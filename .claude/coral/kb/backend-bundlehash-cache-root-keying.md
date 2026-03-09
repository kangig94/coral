# Backend Bundle Hash Cache Must Be Keyed By Plugin Root
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
If a backend lifecycle helper accepts a dynamic `pluginRoot`, any cached manifest-derived value such as `readBundleHash(pluginRoot)` must cache by root, not in a single process-global slot. A global cache is only correct while the process is guaranteed to serve exactly one plugin root for its full lifetime.
## Why
Once lifecycle code moves from a bridge-only module-scope `__PLUGIN_ROOT__` model to a reusable client API, the first call no longer defines a safe global truth. A single cached bundle hash lets the first resolved root silently poison later calls, so replacement and health checks compare backend state against the wrong bundle identity.
## Pattern
Right:
```typescript
const bundleHashCache = new Map<string, string>();

export function readBundleHash(pluginRoot: string): string {
  const cached = bundleHashCache.get(pluginRoot);
  if (cached) return cached;
  const next = readManifest(join(pluginRoot, 'bridge', 'manifest.json'));
  bundleHashCache.set(pluginRoot, next);
  return next;
}
```

Wrong:
```typescript
let cachedBundleHash: string | undefined;

export function readBundleHash(pluginRoot: string): string {
  if (cachedBundleHash) return cachedBundleHash;
  cachedBundleHash = readManifest(join(pluginRoot, 'bridge', 'manifest.json'));
  return cachedBundleHash;
}
```
