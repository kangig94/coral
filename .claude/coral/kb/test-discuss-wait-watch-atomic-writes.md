# Discuss Wait Tests Must Trigger Rename-Based State Updates
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When a test is meant to wake `waitForCondition`, write `state.json` through the same atomic `tmp -> rename` path used in production. Use `writeStateAtomic()` or `SessionStore.save()` for valid states, and if the test needs invalid JSON it should still publish that fixture via rename instead of overwriting the file in place.
## Why
`waitForCondition` watches the parent directory, not the file, because `SessionStore.save()` persists state with `writeStateAtomic()`. Tests that call `writeFileSync(statePath, ...)` bypass that contract and can silently exercise a different notification model than the real session flow.
## Pattern
```ts
// Wrong: mutates state.json in place, so the test is not exercising the
// rename-based wake-up path used by SessionStore.save().
writeFileSync(statePath, JSON.stringify(nextState));
```

```ts
// Right: matches production persistence.
writeStateAtomic(statePath, { ...nextState });

// For corrupt-state tests, keep the rename semantics too.
const tmpPath = `${statePath}.tmp`;
writeFileSync(tmpPath, 'not-json', 'utf8');
renameSync(tmpPath, statePath);
```
