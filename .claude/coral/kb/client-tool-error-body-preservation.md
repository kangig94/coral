# Preserve Structured `/tool` Error Bodies in Shared Client Errors
Promoted: 2026-03-13 | Updated: 2026-03-13
## Rule
When a shared client wraps Coral's `/tool` endpoint for downstream normalization, do not collapse non-2xx responses into a generic status-text error. Parse the response body first and surface a typed error that preserves `statusCode` and parsed JSON `body` when available. Keep the thrown `Error` shape for compatibility, but repair the subclass prototype so downstream `instanceof BackendToolHttpError` checks survive the compiled runtime output.
## Why
Coral's `/tool` surface mixes success envelopes, rejected launch decisions, and real HTTP failures with machine-readable JSON bodies. `abort` is the concrete trap: invalid input returns 400 JSON and scope mismatches return 403 JSON. If the shared client throws only `Backend request failed: 403 Forbidden`, the caller loses the backend's actual contract and cannot normalize errors consistently. Re-parsing HTTP inside each client duplicates transport logic and drifts from the shared backend contract.
## Pattern
```ts
// Wrong: non-OK drops the backend's JSON body.
if (!response.ok) {
  throw new Error(`Backend request failed: ${response.status} ${response.statusText}`);
}
```

```ts
// Right: preserve structured failure while remaining catchable as Error.
class BackendToolHttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const body = await parseJsonResponse(response);
if (!response.ok) {
  throw new BackendToolHttpError(
    describeHttpError(response.status, response.statusText),
    response.status,
    body,
  );
}
return body;
```
