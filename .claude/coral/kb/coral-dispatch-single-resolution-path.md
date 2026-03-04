# Coral Op Resolution Must Have One Path, Not Two

## Rule
Coral op content resolution (`resolveCoralContent`) and prompt injection (system prompt / bypass forcing) must live in the provider adapter's `handleCoralOp`, not split between the server router and the adapter. The server router must detect `coral:*` ops and delegate to `handleCoralDispatch` without rewriting args; the adapter owns all resolver semantics.

## Why
When the router pre-resolves coral content and rewrites args before calling the adapter, the adapter's own coral branch becomes unreachable dead code. Two implementations then diverge silently — one reachable via the server router, one only via direct adapter calls. Drift risk is high: a change to prompt assembly semantics in one path does not propagate to the other.

## Pattern
Right — router detects and delegates, adapter resolves:
```typescript
// server-handlers.ts (router)
if (typeof rawOp === 'string' && rawOp.startsWith('coral:')) {
  return handleCoralDispatch(name, rawArgs, mgr, progressToken, notify);
}
return provider.handleOp(rawArgs, mgr, progressToken, notify);

// coral/dispatch.ts
const resolved = resolveCoralContent(coralName);
return provider.handleCoralOp(coralName, resolved.content, rawArgs, mgr, progressToken, notify);
```
Wrong — router pre-resolves and rewrites:
```typescript
// server-handlers.ts (router) — creates dual path
if (rawOp.startsWith('coral:')) {
  const content = resolveCoralContent(op.slice(6)).content;
  rawArgs = { ...rawArgs, op: 'exec', system_prompt: content, bypass: true };
}
return provider.handleOp(rawArgs, ...); // adapter's coral branch is now dead
```
