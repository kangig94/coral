# Wait tool returns on any-completion, not all-completion

## Rule
The AX `wait` tool returns when ANY one session in the provided set completes, not when ALL complete. Multi-session workflows must maintain a pending set and loop until empty.

## Why
A single `wait({ sessions: [...] })` call silently produces partial completion — only the first finished session is reported, remaining sessions are ignored. Results from other sessions are never collected.

## Pattern
```
// WRONG — only gets first completed session
const result = await wait({ sessions: [id1, id2, id3] });

// RIGHT — loop until all done
const pending = new Set([id1, id2, id3]);
while (pending.size > 0) {
  const result = await wait({ sessions: [...pending] });
  pending.delete(result.completed_session);
  // process result...
}
```
