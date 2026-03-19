# Backend Lock Exclusive Create
## Rule
Claim a singleton `backend.lock` with an actual exclusive create (`writeFileSync(..., { flag: 'wx' })` or equivalent), not `tmp -> rename`. If contenders can read the lock while the owner is still writing it, treat invalid/corrupt contents as a bounded startup-in-progress state instead of clearing them immediately.

## Why
`rename()` replaces an existing file, so a temp-file handoff does not preserve exclusivity and can silently overwrite a live owner's lock. Even with real exclusive create, contenders may still observe a partially written file between create and write completion; if that invalid read is treated as stale right away, they can evict a healthy owner during startup.

## Pattern
```ts
// Wrong
writeFileSync(tmpPath, payload);
renameSync(tmpPath, lockPath); // overwrites existing owner on POSIX
```

```ts
// Right
writeFileSync(lockPath, payload, { flag: 'wx' });
// contender: invalid lock contents => wait/retry until deadline, then clear only if unchanged
```
