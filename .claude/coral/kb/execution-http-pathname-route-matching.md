# Match Raw HTTP Routes On Pathname, Not req.url
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
In raw `node:http` handlers, treat `req.url` as the full request target, not just the path. Parse it with `new URL(req.url, 'http://localhost')`, match routes against `pathname`, and read filters from `searchParams`. This keeps collection routes like `/api/jobs?phase=running` on the collection handler and prevents detail-route regexes from capturing query text as part of an ID.
## Why
Direct equality or regex checks on `req.url` silently mix routing with query parsing. A list route misses valid requests once query parameters are added, and a detail route can receive IDs like `abc123?foo=bar`, which breaks lookup behavior in ways that look like missing data rather than incorrect routing.
## Pattern
```ts
// Right: route on pathname, then read query filters separately.
if (req.method === 'GET' && req.url) {
  const parsedUrl = new URL(req.url, 'http://localhost');

  if (parsedUrl.pathname === '/api/jobs') {
    const phase = parsedUrl.searchParams.get('phase');
    return listJobs(phase);
  }

  const match = parsedUrl.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (match) {
    return getJob(match[1]);
  }
}
```

```ts
// Wrong: query parameters change route matching and can pollute IDs.
if (req.method === 'GET' && req.url === '/api/jobs') {
  return listJobs();
}

const match = req.url?.match(/^\/api\/jobs\/([^/]+)$/);
if (match) {
  return getJob(match[1]);
}
```
