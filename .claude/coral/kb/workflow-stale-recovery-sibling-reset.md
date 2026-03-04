# Stale Recovery Sibling False-Positive

## Rule
After a stale atom recovery cycle (abort + resume dispatch), reset `lastActivityTime` for ALL pending sibling atoms to `Date.now()`. The async recovery awaits introduce latency that counts against siblings' stale timers, causing false-positive stale detection on the next poll iteration.

## Why
Without the reset, the break-after-recovery pattern exits the inner stale-detection loop and restarts the outer while-loop. By then, siblings' `lastActivityTime` is stale by the duration of the recovery awaits (abort + dispatch). With short custom timeouts or accumulated recovery latency, siblings get falsely marked as stale even though they are legitimately running.

## Pattern
```typescript
// WRONG: recover one atom, break, siblings now appear stale
await requestAbort(atom.session);
const resumed = await dispatch(...);
sessionOverlay.set(atom.agent, resumed);
break; // siblings' lastActivityTime unchanged

// RIGHT: reset siblings after recovery, then break
await requestAbort(atom.session);
const resumed = await dispatch(...);
sessionOverlay.set(atom.agent, resumed);
for (const sibling of atoms) {
  if (sibling.agent === atom.agent) continue;
  if (pending.has(sessionOverlay.get(sibling.agent)!.session)) {
    lastActivityTime.set(sibling.agent, Date.now());
  }
}
break;
```
