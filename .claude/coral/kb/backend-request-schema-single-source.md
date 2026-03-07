# Backend Request Schema Must Drive Both Tool Metadata and Routing
## Rule
Do not define backend request shapes in separate layers that can drift. The same source of truth must drive MCP tool metadata, request validation, and field forwarding into execution. If the backend hard-codes tool descriptors or manually picks fields while separate schema modules define a richer contract, fields will silently go dark.
## Why
During an architectural scan, the backend router exposed only `op`, `prompt`, `session`, and `work_dir`, while execution/service and provider layers still carried `model`, `effort`, and `systemPrompt` support. Separate schema modules existed, but the backend did not derive metadata or routing from them, so request capabilities diverged across layers and the unused schema surface stopped reflecting runtime behavior.
## Pattern
Right:
```typescript
const execSchema = z.object({
  op: z.literal('exec'),
  prompt: z.string(),
  model: z.string().optional(),
  effort: effortSchema,
});

const toolDescriptor = zodToJsonSchema(execSchema);

function route(args: unknown) {
  const input = execSchema.parse(args);
  return service.start(provider, {
    prompt: input.prompt,
    model: input.model,
    effort: input.effort,
  }, ctx);
}
```

Wrong:
```typescript
// metadata says one thing
inputSchema = { properties: { op, prompt, session, work_dir } };

// router hand-picks a slightly different subset
const prompt = optionalString(args, 'prompt');
const cwd = optionalString(args, 'work_dir');

// separate schema files define fields nobody forwards
export const sharedExecSchema = z.object({ op, prompt, model, effort });
```
