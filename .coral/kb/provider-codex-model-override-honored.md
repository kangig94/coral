# Codex Provider Honors Request-Level Model Overrides
Promoted: 2026-03-09 | Updated: 2026-03-10
## Rule
When reasoning about Coral's Codex provider, assume a request-level `model` override flows through to the launched CLI model. The executor now resolves Codex launches as `opts.model ?? (CORAL_CODEX_MODEL ?? 'gpt-5.4')` for both one-shot and resume execution.
## Why
The API surface already exposes `model` on shared schemas, execution requests, and provider adapters, so stale knowledge that Codex ignores `request.model` will now misdiagnose provider parity, CLI launch behavior, and test failures. After the executor fix, Claude and Codex both honor request-level model selection at the shared execution boundary.
## Pattern
```ts
// Right mental model: request.model controls the Codex CLI model when provided
service.start('codex', { prompt: '...', model: 'o4-mini' }, ctx)
// Codex launches with -m o4-mini

// Executor fallback still applies when no override is provided
const DEFAULT_MODEL = process.env.CORAL_CODEX_MODEL ?? 'gpt-5.4';
function getModel(model?: string): string {
  return model ?? DEFAULT_MODEL;
}
```

```ts
// Wrong: forcing the fallback hides the request-level override
const resolvedModel = getDefaultModel();
```
