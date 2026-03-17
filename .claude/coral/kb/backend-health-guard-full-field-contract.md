# Shared BackendHealth Guard Requires All 10 Fields
Promoted: 2026-03-17 | Updated: 2026-03-17
## Rule
The unified `isBackendHealth()` guard in `src/client/backend-health.ts` validates all 10 fields including `queueDepth`. All mock health responses in tests must include the full field set, not just the subset that a particular consumer uses.
## Why
Before consolidation, `backend-lifecycle.ts` had a lenient 5-field guard and `http-client.ts` had a strict 10-field guard. After unification, the single guard is strict. Test fixtures using the old minimal set (status, version, bundleHash, instanceId, namespace) will fail the guard silently — the health check returns `null` and the ensureBackend loop times out at 5 seconds instead of producing a clear error.
## Pattern
```typescript
// Right: use makeBackendStatus() which includes all fields
fetchMock.mockResolvedValueOnce(jsonResponse(makeBackendStatus({
  version: info.version,
  bundleHash: info.bundleHash,
  instanceId: info.instanceId,
  namespace: info.namespace,
})));

// Wrong: inline partial payload missing queueDepth/uptimeMs/etc
fetchMock.mockResolvedValueOnce(jsonResponse({
  status: 'ok',
  version: info.version,
  bundleHash: info.bundleHash,
  instanceId: info.instanceId,
  namespace: info.namespace,
})); // isBackendHealth() returns false → timeout
```
