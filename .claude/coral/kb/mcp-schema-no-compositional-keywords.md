# MCP Tool Schema: No oneOf/allOf/anyOf
Promoted: 2026-03-11
## Rule
Never use `oneOf`, `allOf`, or `anyOf` in MCP tool `inputSchema` declarations. Claude API rejects these JSON Schema compositional keywords during tool registration. Handle variant validation in handler code (e.g., Zod union) instead. Also avoid property-level `description` fields — they waste tokens on every tool list fetch. Keep usage hints in the tool-level description only.
## Why
When any tool in the MCP server list uses compositional keywords, the entire server's tools become unavailable to subagents (Explore, Agent, etc.). Subagents spawn but complete with 0 tool uses — a silent, hard-to-diagnose failure.
## Pattern
Right — flat schema, variant logic in Zod:
```typescript
// Schema declaration (no oneOf)
inputSchema: {
  type: 'object',
  properties: {
    session: { type: 'string' },
    score: { type: 'integer' },
    content: { type: 'string' },
  },
  required: ['session'],
}
// Handler uses Zod union for bid-vs-speech validation
const parsed = z.union([bidSchema, speechSchema]).safeParse(args);
```

Wrong — compositional keywords in schema:
```typescript
inputSchema: {
  type: 'object',
  properties: { session, score, content },
  required: ['session'],
  oneOf: [
    { required: ['score', 'thought'] },
    { required: ['content'] },
  ],
}
```
