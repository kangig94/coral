# Queue Permit Signal Bridge
## Rule
When the execution service owns launch admission but provider executors cannot yet accept a new permit parameter, bind the reserved `jobId` to the existing `AbortSignal` and let `spawnCli()` consume that binding before it performs its fallback capacity check. This keeps slot accounting authoritative in `engine.ts` without widening the provider runtime mid-rollout.

## Why
If the service reserves a slot and the unchanged executor still calls `spawnCli()` with no permit context, the child spawn path re-checks capacity and can incorrectly throw `CliBusyError` for a job that already owns a launch reservation. That breaks queued dispatch even though admission succeeded earlier.

## Pattern
Right:
```typescript
// service.ts
bindLaunchPermit(jobId, signal);
await provider.execute(request, { signal, onEvent });

// engine.ts
const usingReservedPermit = options.signal
  ? consumeSignalPermit(options.signal, options.provider)
  : false;
```

Wrong:
```typescript
// service reserves capacity...
requestLaunch(jobId, providerName);

// ...but executor still re-checks raw capacity with no reservation context
await spawnCli({ provider: providerName, signal });
```
