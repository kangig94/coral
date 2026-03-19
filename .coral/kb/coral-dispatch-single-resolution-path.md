# Coral Op Resolution Must Have One Path, Not Two

## Rule
Coral op content resolution and metadata stripping must be centralized in `src/coral/dispatch.ts` (`resolveCoralContent` + `stripAgentMetadata`) before calling provider adapters. Adapters own provider-specific prompt assembly only (for example, Codex prepend vs Claude `system_prompt`) and must not re-resolve or re-strip.

## Why
If stripping happens in both dispatch and adapters, behavior diverges between normal routing and direct adapter calls, and bugs appear as double-stripping or mismatched prompts. A single dispatch-owned resolution path keeps contracts stable: adapters receive already-clean agent content and only decide how to place it for their CLI.

## Pattern
Right — router delegates, dispatch resolves + strips, adapter assembles:
```typescript
// server-handlers.ts (router)
if (typeof rawOp === 'string' && rawOp.startsWith('coral:')) {
  return handleCoralDispatch(name, rawArgs, mgr, progressToken, notify);
}
return provider.handleOp(rawArgs, mgr, progressToken, notify);

// coral/dispatch.ts
const { content } = resolveCoralContent(coralName);
const agentPrompt = stripAgentMetadata(content);
return provider.handleCoralOp(coralName, agentPrompt, rawArgs, mgr, progressToken, notify);
```
Wrong — adapter strips again (dual stripping path):
```typescript
// providers/claude/server-handlers.ts
const systemPrompt = stripAgentMetadata(coralContent); // redundant when dispatch already stripped
```
