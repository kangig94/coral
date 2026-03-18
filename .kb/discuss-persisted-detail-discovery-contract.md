# Persisted Discuss Detail Must Share the Discovery Contract
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
Backend persisted-detail lookup and cold-scan discovery must resolve discuss sessions through the same contract. If `discovery.json` is the canonical index, both the backend `/api/discuss/detail` fallback and downstream scanners should use it; if directory naming is canonical, do not let only one side depend on that naming scheme.
## Why
Split discovery rules create asymmetric failures: one consumer can find a session while another reports it missing, even though both are looking at the same on-disk data. Session-id format changes then become partial breakages that are hard to diagnose because they only affect one access path.
## Pattern
Right:
```ts
const discovery = readDiscussDiscovery(projectRoot);
const sessionDir = discovery?.sessions.find((s) => s.sessionId === sessionId)?.sessionDir ?? null;
```

Wrong:
```ts
// Backend guesses from directory naming...
const match = entries.find((name) => name.startsWith(`${sessionId}-`));

// ...while another consumer trusts discovery.json.
```
