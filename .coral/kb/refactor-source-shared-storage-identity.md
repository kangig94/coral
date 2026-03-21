# Shared Storage Migration Must Replace Physical-Root Identity
Promoted: 2026-03-21 | Updated: 2026-03-21
## Rule
When moving persisted data from project-local storage into a source-shared home directory, update every persisted identity surface together: registry files, store cache keys, replay/load guards, list/detail endpoints, and any dedupe logic. The canonical source key (`owner/repo` or `local/dirname`) must become the shared identity. Physical `projectRoot` can remain as metadata for display or runtime context, but it cannot remain the persisted lookup key.
## Why
Path-only migrations create false sharing. Two clones of the same repo will point at the same directory, but snapshots, event logs, registries, and APIs still reject or duplicate each other if they continue keying by raw checkout path. The failure hides until an alternate checkout tries to list or load persisted state and sees duplicate enumeration, replay rejection, or "not found" behavior against data that is already on disk.
## Pattern
Right:
```text
disk path        -> ~/.coral/projects/{source-slug}/...
registry entry   -> source
store cache key  -> source
detail lookup    -> resolve source first, then load shared store
projectRoot      -> informational metadata only
```

Wrong:
```text
disk path        -> ~/.coral/projects/{source-slug}/...
registry entry   -> /Users/me/repo-a
store cache key  -> /Users/me/repo-b
detail lookup    -> require exact projectRoot match
```
