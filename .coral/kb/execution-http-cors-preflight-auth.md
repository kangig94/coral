# CORS Preflight Must Bypass Auth In Raw HTTP Server
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
When the Coral backend adds browser-facing CORS support on top of raw `node:http`, set the `Access-Control-*` headers at the start of the main request handler and return `OPTIONS` before auth or lifecycle checks. That keeps preflight unauthenticated and ensures normal error responses like `401`, `403`, `404`, and `503` still carry CORS headers.
## Why
If token auth runs before the preflight branch, browsers receive `401` on `OPTIONS` and block the real request before it reaches the backend. If CORS headers are only applied on success routes, browser clients see opaque CORS failures instead of the backend's actual JSON error payloads.
## Pattern
```ts
// Right: apply headers to every response, then short-circuit preflight.
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Headers', 'X-Coral-Backend-Token, Content-Type');
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

if (req.method === 'OPTIONS') {
  res.writeHead(204);
  res.end();
  return;
}

if (req.headers['x-coral-backend-token'] !== token) {
  sendJson(res, 401, { error: 'unauthorized' });
}
```

```ts
// Wrong: auth runs first, so browser preflight never succeeds.
if (req.headers['x-coral-backend-token'] !== token) {
  sendJson(res, 401, { error: 'unauthorized' });
  return;
}

if (req.method === 'OPTIONS') {
  res.writeHead(204);
  res.end();
}
```
