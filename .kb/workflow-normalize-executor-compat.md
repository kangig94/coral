# Workflow: Keep Executor Namespace Guard When Moving Validation to Handler
## Rule
When moving duplicate-check and normalization from the parser/executor to the handler layer, the executor's namespace fallback/check (`atom.namespace ?? 'coral'`, reject non-coral) must be retained as a compatibility layer. Removing it breaks any caller that invokes `executePipeline` directly (e.g., tests, future integrations) with a raw `parseExpression` AST where `namespace` is still `undefined`.
## Why
`parseExpression` returns atoms with `namespace: undefined` (optional field). After moving normalization to `handleWorkflow`, the handler fills defaults before calling `executePipeline`. But `executePipeline` is a public exported function — callers who bypass the handler pass un-normalized ASTs. Without the executor guard, `atom.namespace ?? 'coral'` in `launchAtomWithRetry` prevents the silent failure: an atom with `namespace: undefined` would dispatch as `coral:agent` correctly, but without the explicit check, a non-coral namespace would silently succeed or fail with a confusing message.

The handler normalization is the primary path; the executor guard is defense-in-depth for direct callers.
## Pattern
```typescript
// Right: keep executor guard as compatibility layer
if (atom.kind === 'agent') {
  const namespace = atom.namespace ?? 'coral';  // fallback for direct callers
  if (namespace !== 'coral') {
    throw new Error(`unsupported namespace "${namespace}"`);
  }
  // ... dispatch
}

// Wrong: remove guard assuming handler always normalizes
// (breaks direct executePipeline callers and tests)
```
