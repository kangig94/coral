# Cross-Process Locking: mkdir vs Promise Chain

## Rule
When multiple processes share mutable state via files (e.g., MCP servers in Agent Teams where each teammate spawns its own process), use cross-process locking (`mkdir`-based atomic test-and-set), NOT in-process Promise chains. Promise chains only serialize within a single process. Additionally, Promise-chain mutexes can suffer rejection poisoning if prior rejections aren't absorbed.

## Why
In Claude Code Agent Teams, each teammate runs its own MCP server process. Multiple processes doing read-modify-write on the same state file causes lost updates even with atomic rename (rename prevents partial writes, not concurrent read-modify-write races). In-process mutexes are invisible to other processes.

## Pattern
```typescript
// Right — cross-process lock via mkdir (POSIX atomic)
fs.mkdirSync(lockDir);  // fails EEXIST if held
try { return await fn(); }
finally { fs.rmdirSync(lockDir); }
// + stale lock recovery (10s timeout) + exponential backoff retry

// Wrong — in-process only, invisible to other processes
const prev = chains.get(id) ?? Promise.resolve();
prev.then(fn);  // only serializes within THIS process
```
