# Tests for Provider Coral Ops Must Call handleCoralOp Directly

## Rule
Tests that exercise a provider's coral op behavior must call `adapter.handleCoralOp(coralName, resolvedContent, rawArgs, mgr)` directly. They must NOT call `handleOp({ op: 'coral:...' })` — after the dispatch refactor, `handleOp` only handles native ops (`exec|list|abort` etc.) and will return an error for coral ops.

## Why
The dispatch layer (`coral/dispatch.ts`) resolves coral content via `resolveCoralContent()` before calling `provider.handleCoralOp(coralName, content, rawArgs, mgr)`. The provider's `handleOp` never sees coral ops — they are intercepted at the router level. Tests that bypass the router and call `handleOp` with a coral op will get `unknown_op` instead of testing the coral behavior.

## Pattern
Right — call the adapter method directly with resolved content:
```typescript
import { resolveCoralContent } from '../../../coral/resolver.js';
const result = await claudeAdapter.handleCoralOp(
  'frontmatter',
  resolveCoralContent('frontmatter').content,
  { op: 'coral:frontmatter', prompt: 'Implement this', name: 'my-session' },
  mgr,
);
```
Wrong — coral op via handleOp (returns error, never reaches coral logic):
```typescript
const result = await handleClaudeOp(
  { op: 'coral:frontmatter', prompt: 'Implement this', name: 'my-session' },
  mgr,
);
// result.isError === true, coral behavior never exercised
```
