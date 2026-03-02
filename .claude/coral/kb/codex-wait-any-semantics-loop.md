# Codex wait op returns on any-completion, not all-completion

## Rule
The MCP `wait` operation returns when ANY one job in the provided set completes, not when ALL complete. Multi-job workflows must maintain a pending set and loop until empty.

## Why
A single `wait(job_ids: [...])` call silently produces partial completion — only the first finished job is reported, remaining jobs are ignored. Results from other jobs are never collected.

## Pattern
```
// WRONG — only gets first completed job
const result = await codex({ op: "wait", job_ids: [id1, id2, id3] });

// RIGHT — loop until all done
const pending = new Set([id1, id2, id3]);
while (pending.size > 0) {
  const result = await codex({ op: "wait", job_ids: [...pending] });
  pending.delete(result.completed_job_id);
  // process result...
}
```
