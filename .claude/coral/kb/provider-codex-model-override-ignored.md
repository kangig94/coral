# Codex Provider Ignores Request-Level Model Overrides
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When reasoning about Coral's Codex provider, do not assume a request-level `model` override changes the launched CLI model. The current executor always resolves Codex launches to `CORAL_CODEX_MODEL` (or `gpt-5.4`), regardless of the model passed through the request pipeline.
## Why
The API surface exposes `model` on shared schemas, execution requests, and provider adapters, so reviewers can easily assume Codex behaves like Claude here. That assumption is false today: behavior diverges silently at the executor boundary, which can invalidate tests, reviews, and debugging conclusions about provider parity.
## Pattern
```ts
// Wrong mental model: request.model controls the Codex CLI model
service.start('codex', { prompt: '...', model: 'o4-mini' }, ctx)

// Actual behavior: codex-executor ignores request.model and uses DEFAULT_MODEL
const DEFAULT_MODEL = process.env.CORAL_CODEX_MODEL ?? 'gpt-5.4';
function getModel(_model?: string): string {
  return DEFAULT_MODEL;
}
```
