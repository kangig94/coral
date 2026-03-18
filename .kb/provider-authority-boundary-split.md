# Provider Authority Must Be Split By Boundary

## Rule
Provider extensibility requires two distinct authority models: (1) **identifier-format authority** at parse/persistence boundaries — any lowercase-letters/digits/hyphens string is valid; (2) **registry-membership authority** at dispatch/execution boundaries — only registered providers are allowed. Attempting to use registry membership for persistence breaks session forward-compatibility; using identifier-only checks at dispatch breaks runtime safety.

## Why
If you gate persistence on registry membership, sessions for providers registered after write time are rejected on read. If you use identifier-only checks everywhere, dispatch silently accepts unknown providers. Either error alone defeats the extensibility goal. Both architect and critic independently surfaced this contradiction during plan review; it must be resolved explicitly in plan acceptance criteria before implementation begins.

## Pattern
Right — split by boundary:
```typescript
// Parse/persist: accept any valid identifier shape
const providerIdentPattern = /^[a-z][a-z0-9-]*$/;
export function isProviderIdent(s: unknown): s is string {
  return typeof s === 'string' && providerIdentPattern.test(s);
}

// Dispatch: enforce registry membership
const provider = getProvider(name);
if (!provider) return textResult(`Unknown provider: ${name}`, true);
```
Wrong — uniform registry check:
```typescript
// Breaks read-back of sessions written before provider was registered
if (!getProvider(session.provider)) throw new Error('Unknown provider');
```
Wrong — identifier-only everywhere:
```typescript
// Allows dispatch to unknown providers, silent undefined behavior
if (!isProviderIdent(name)) return error;
return await someHandler(name, ...); // name may not be registered
```
