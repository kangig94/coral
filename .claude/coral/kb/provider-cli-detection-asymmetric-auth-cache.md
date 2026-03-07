# Provider CLI Detection Asymmetric Auth Cache
## Rule
CLI detector caching must stay asymmetric: cache the binary/version probe, treat `available: false` as terminal until reset, and make a confirmed authenticated result sticky for process lifetime, but re-run auth detection on every later call when the last auth result was `unauthenticated` or `unknown`.
## Why
Flattening the cache to "return any cached available result" hides real login/logout changes until process restart and breaks the contract the provider adapters already rely on. The detector is intentionally optimized only for the stable cases: missing binary and confirmed auth.
## Pattern
Right:
```typescript
if (cachedCli !== null && (confirmedAuth || !cachedCli.available)) {
  return cachedCli;
}

const cli = cachedCli ?? await queryCliVersion();
const auth = await queryAuthState();
```

Wrong:
```typescript
if (cachedCli !== null) {
  return cachedCli;
}
```
