# Workflow: Two Distinct `prompt` Namespaces
## Rule
The workflow codebase has two unrelated `prompt` fields — never rename them together. The schema-level field (`WorkflowInput.init_prompt`, formerly `prompt`) is the user-facing workflow tool parameter. The provider-level field (`input.prompt` in `coralDispatch` calls at `service.ts:220,271,326,367,382`) is the per-atom execution prompt that every provider adapter expects. During any refactor of the workflow schema, touch only the former.
## Why
`service.ts` uses `input.prompt` in many `coralDispatch` calls that are completely unrelated to the workflow schema field. Mass-renaming `prompt` → `init_prompt` across the service file would silently break atom dispatch — the provider receives `undefined` as the prompt with no type error because the input objects are untyped at that call site.
## Pattern
```typescript
// Schema level (WorkflowInput) — rename here
init_prompt: z.string().min(1, 'Prompt required'),

// Provider dispatch level — DO NOT rename, these are unrelated
this.start(providerName, { prompt: input.prompt, ... });       // service.ts:382
this.coralDispatch(provider, name, { prompt: atomPrompt, ... }); // pipe-executor.ts:256
```
