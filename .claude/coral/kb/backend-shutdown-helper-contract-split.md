# Backend Shutdown Helpers Need Separate User-Facing and Replacement Contracts
## Rule
Do not reuse a best-effort backend shutdown helper for a user-facing MCP management tool. Replacement logic may safely treat `/admin/shutdown` as advisory and ignore failures while polling for handoff, but a bridge `backend { op: "shutdown" }` path must use a strict helper that validates the HTTP response contract and preserves draining/auth/unavailable failures instead of collapsing them to success.
## Why
The replacement path and the management path have different truth requirements. Version handoff can tolerate a dropped shutdown request because it already loops on lock and health state, but a user-facing tool becomes misleading if it reports success after a `401`, `503`, timeout, or connection failure. That hides the real daemon state and makes lifecycle races impossible to reason about from the MCP layer.
## Pattern
Right:
```typescript
async function requestBackendShutdownStrict(info: BackendInfo): Promise<'shutting_down'> {
  const response = await fetch(url, { method: 'POST', headers });
  if (!response.ok) throw new Error(describeHttpError(response.status, response.statusText));
  const body = await response.json();
  if (body.status !== 'shutting_down') throw new Error('Unexpected shutdown response');
  return 'shutting_down';
}

async function requestBackendShutdownBestEffort(info: BackendInfo): Promise<void> {
  try {
    await requestBackendShutdownStrict(info);
  } catch {
    /* replacement handoff retries elsewhere */
  }
}
```
Wrong:
```typescript
export async function backendToolShutdown() {
  await requestBackendShutdown(info); // swallows 401/503/network failures
  return textResult('shutdown requested');
}
```
