# Preserve Bridge Backend Status Shape When Adding Richer Lifecycle States
Promoted: 2026-03-13 | Updated: 2026-03-13
## Rule
When the bridge needs a richer non-autostart backend status helper, add a new discriminated helper that wraps the existing bridge `BackendStatus` payload instead of widening or replacing the legacy status shape. Keep the older `getBackendStatus()` contract stable and let the new helper distinguish extra states such as `unauthorized` and `not_running`.
## Why
The bridge lifecycle surface already has a public mental model: `getBackendStatus()` returns either the existing `'ok'` payload or `'shutting_down'`, and callers treat everything else as unavailable. The client-side health type is richer, but reusing it in the bridge would silently change the bridge payload shape and blur the boundary between legacy consumers and new CLI-specific lifecycle needs.
## Pattern
```ts
// Right: add a new helper for richer state while preserving the old bridge payload.
type BackendStatusFull =
  | { status: 'ok'; health: Extract<BackendStatus, { status: 'ok' }> }
  | { status: 'shutting_down' | 'unauthorized' | 'not_running' };

export async function getBackendStatus(): Promise<BackendStatus | null> {
  const status = await getBackendStatusFull();
  if (status.status === 'ok') return status.health;
  if (status.status === 'shutting_down') return { status: 'shutting_down' };
  return null;
}
```

```ts
// Wrong: widen the old bridge type just because a new caller needs more states.
export type BackendStatus = BackendHealth | { status: 'shutting_down' | 'unauthorized' | 'not_running' };
```
