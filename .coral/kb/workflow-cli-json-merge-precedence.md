# Strip Workflow Control Fields Before Merging CLI JSON
Promoted: 2026-03-13 | Updated: 2026-03-13
## Rule
When the workflow CLI accepts `--json` input and then calls `BackendClient.workflow(expression, options)`, remove `expression` and `init_prompt` from the JSON object before passing the remaining payload as `options`. Compute the final `expression` and `init_prompt` values separately so explicit flags can override JSON without being overwritten again during client request assembly.
## Why
`BackendClient.workflow()` constructs `{ expression, ...options }`. If the forwarded `options` object still contains `expression`, that stale JSON field silently overrides the explicit function argument and breaks the CLI's intended precedence rules. The same boundary applies to `init_prompt`: it should be resolved once, then written back as the final payload field.
## Pattern
```ts
const {
  expression: baseExpression,
  init_prompt: baseInitPrompt,
  ...basePayload
} = await readJsonFlag(opts.json);

const expression = opts.expression ?? baseExpression;
const initPrompt = opts.initPrompt ?? baseInitPrompt;

await client.workflow(expression, {
  ...basePayload,
  init_prompt: initPrompt,
});
```

```ts
// Wrong: `base.expression` can override the explicit `expression` arg.
const base = await readJsonFlag(opts.json);
await client.workflow(expression, { ...base, init_prompt });
```
