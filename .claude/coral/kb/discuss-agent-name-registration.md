# Discuss Agent Must Use Registered agent_name, Not Display Name

## Rule
When calling `discuss({ op: 'bid', agent_name: ... })` or `discuss({ op: 'speak', agent_name: ... })`, the `agent_name` field must be the exact lowercase registered name (e.g., `"Klaus"` → `"klaus"`), not the persona display name (e.g., `"Klaus Becker"` or `"Jisoo Park"`). The `agent_name` field validates against `identPattern` (`/^[a-zA-Z0-9][a-zA-Z0-9._-]*/`), which rejects spaces and non-ASCII characters.

## Why
Agents receiving their persona description naturally use their full display name. If they call `discuss` with the display name, Zod validation fails with `agent_not_found`, and the moderator's `_3_step` timeout expels them before they can correct it — ending the session after only 1 speech.

## Pattern
```typescript
// In the agent spawn prompt — be explicit:
// Your registered agent_name is: "alice"  (use this exactly for discuss() calls)
// Your display name is: "Alice Nakamura"  (use only in speech content)

// WRONG
discuss({ op: 'bid', agent_name: 'Alice Nakamura', score: 80, thought: '...' })

// RIGHT
discuss({ op: 'bid', agent_name: 'alice', score: 80, thought: '...' })
```
