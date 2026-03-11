# Reef Discuss Detail Transcript Contract
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
`coral-reef` remote discuss sync and `coral`'s `/api/discuss/detail` must agree on one transcript location. If the backend returns transcript entries nested under `session.transcript`, the sync layer must read that exact field; if the sync layer expects a top-level `transcript`, the backend must expose it there. Do not let local cold-scan rebuild `transcript_entries` from `state.json` while remote sync silently skips them because it reads a different shape.
## Why
This drift is easy to miss because `stateJson` can still contain a nested transcript, so the remote detail response looks superficially complete. But reef's API and UI read `transcript_entries`, not `stateJson`, so the remote path ends up with empty transcript tables while the local path shows data. The bug presents as "remote discuss sync works except transcript" even though the real failure is a contract mismatch between the two services.
## Pattern
Right:
```ts
// Backend shape
{ authority, session: { ..., transcript: [...] } }

// Sync reads the same location
const detailSession = detail?.session;
const transcript = Array.isArray(detailSession?.transcript) ? detailSession.transcript : [];
```

Wrong:
```ts
// Backend nests transcript under session...
{ authority, session: { ..., transcript: [...] } }

// ...but sync expects a different top-level field.
const transcript = detail?.transcript;
```
