# Shared Skill Handoff Files Must Migrate as One Contract
Promoted: 2026-03-21 | Updated: 2026-03-21
## Rule
When multiple skills coordinate through the same durable file, treat that path and file shape as one contract. A storage migration must update every reader, writer, and cleanup path together. Migrating only the producer or only the consumer leaves the cross-skill flow broken even when each individual skill still looks locally correct.
## Why
Some user flows are split across separate skills. If one skill starts writing a shared handoff file in the new location but its companion skill still reads or deletes the old path, the state becomes invisible or cleanup leaves stale pointers behind. Single-skill review often misses this because the bug lives in the shared contract between the skills, not inside either skill alone.
## Pattern
Right:
```text
/discuss --user -> writes ~/.coral/projects/{slug}/discuss/active-user-session.json
/bid            -> reads and deletes the same derived path
migration plan  -> names both skills and the shared file contract
```

Wrong:
```text
/discuss --user -> writes ~/.coral/projects/{slug}/discuss/active-user-session.json
/bid            -> still reads .coral/discuss/active-user-session.json
migration plan  -> updates only the skill that starts the session
```
