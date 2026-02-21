# Regex Optional Prefix Backtracking Trap

## Rule
Never make a prefix character optional inside the same regex that captures content following it. When `#` is optional via `#?`, the engine can backtrack and include the `#` itself in the capture group, producing garbage. Strip the prefix first, then match on the stripped string.

## Why
For pattern `/^#?\s*(.+?)\s+[—–-]\s+/` on `# — dash only`:
1. Engine tries `#?` = `#`, `\s*` = ` `, `(.+?)` tries to match before `—` — no name found
2. Engine backtracks: `#?` = empty, `\s*` = empty, `(.+?)` = `#` — succeeds! Name = `#` (wrong)

## Pattern
```typescript
// WRONG — optional prefix causes backtracking, captures the prefix itself
const match = line.match(/^#?\s*(.+?)\s+[—–-]\s+/);

// RIGHT — strip prefix first, then match cleanly
const stripped = line.replace(/^#\s*/, '');
const match = stripped.match(/^(.+?)\s+[—–-]\s+/);
// No optional group → no backtracking path → correct capture
```
