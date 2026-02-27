# MCP InputSchema Op Enum Omission for Agent Isolation

## Rule
MCP `inputSchema` is informational metadata for the LLM — it controls what ops the model discovers. Zod discriminated union does the actual parsing and routing. These two schemas are independent: omitting an op from the `inputSchema` enum while keeping it in the Zod union makes the op undiscoverable to the LLM but still functional if called. This is a zero-cost way to restrict op usage to specific callers without needing separate MCP tools or caller-identity enforcement.

## Why
Some ops should only be called by the main context, not by spawned agents (e.g., `_7_end` in discuss). Creating separate MCP tools for different callers adds protocol complexity. Omitting from inputSchema is simpler — agents won't see the op in tool metadata, so they won't call it, but the op still works if invoked directly by a caller that knows about it.

## Pattern
```typescript
// inputSchema enum — controls LLM discoverability
op: { type: "string", enum: ["_1_seed", "_2_create", "_3_step", "_4_transcript", "_5_epoch", "_6_state"] }
// _7_end intentionally omitted — main context calls it directly

// Zod union — controls actual parsing (includes _7_end)
z.discriminatedUnion("op", [seedSchema, createSchema, stepSchema, ..., endSchema])
// _7_end still parsed and routed correctly when called
```
