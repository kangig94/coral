# Workflow Nested Dispatch Op Contract
## Rule
When a workflow executor dispatches nested AX tool calls through `handleToolCall`, it must build provider-compatible payloads including an explicit `op` field (`coral:<agent>` for agent atoms) rather than forwarding only shared execution fields. `model`, `working_directory`, `reasoning_effort`, and `bypass` are insufficient without the operation discriminator.
## Why
AX codex/claude handlers are discriminated by `op`. If a workflow layer omits `op`, nested dispatch fails validation and pipeline steps error despite otherwise-correct retry/polling logic. This creates integration failures that look like executor bugs but are actually request-shape contract violations.
## Pattern
Right:
```typescript
const dispatchArgs = {
  op: `coral:${atom.agent}`,
  prompt: atomPrompt,
  ...executionParams,
};
await handleToolCall(provider, dispatchArgs, sessionManager, progressToken, notify);
```
Wrong:
```typescript
await handleToolCall(provider, {
  prompt: atomPrompt,
  model,
  working_directory,
  reasoning_effort,
  bypass,
}, sessionManager, progressToken, notify);
```
