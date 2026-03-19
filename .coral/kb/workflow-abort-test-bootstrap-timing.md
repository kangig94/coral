# Workflow Abort Test: Schedule Failure After Bootstrap

## Rule
When testing `executePipeline` sibling-abort behavior, schedule the failing atom's terminal error after `BOOTSTRAP_TIMEOUT_MS` settles. Failures written during bootstrap are consumed by `readLaunchBootstrapStatus()` inside `launchAtomWithRetry`, causing launch-time failure before `waitForAllAtoms()` runs — so sibling abort paths are never exercised.

## Why
Writing failure too early makes the test cover launch-error handling instead of the intended wait-phase abort-cascade logic. The test passes but validates the wrong code path.

## Pattern
```typescript
// WRONG: failure during bootstrap — caught by launchAtomWithRetry
writeSessionError(atomDir, 'fail');  // immediate

// RIGHT: failure after bootstrap — caught by waitForAllAtoms
setTimeout(() => writeSessionError(atomDir, 'fail'), BOOTSTRAP_TIMEOUT_MS + 50);
```
