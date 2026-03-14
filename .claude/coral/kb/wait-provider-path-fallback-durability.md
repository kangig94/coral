# Wait Path-First Contracts Need Durable Provider Artifacts
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
Do not teach a universal `result.content ?? Read(result.path)` wait pattern unless the provider-side artifact at `result.path` is durably written before terminal completion is exposed. If provider artifact persistence is best-effort, either keep the fallback contract workflow-only or harden provider writes in the same change.
## Why
Path-first response shaping is meant to make large outputs retrievable when inline content is omitted. In Coral's provider path, the terminal result is exposed from in-memory `result.content`, then `writeResultMd()` is attempted separately and silently ignores filesystem failures. If docs, skills, or hooks present `Read(result.path)` as the general fallback, large provider results can become unreachable exactly when `result.content` is removed for size.
## Pattern
Right:
```typescript
// Either harden provider artifact persistence...
writeResultMdOrThrow(jobId, result.content);
appendTerminal(jobId, sessionId, terminalResult, phase);

// ...or narrow the contract.
if (result.workflow) {
  return result.content ?? Read(result.path);
}
// provider path fallback is best-effort until persistence is hardened
```

Wrong:
```typescript
appendTerminal(jobId, sessionId, terminalResult, phase);
writeResultMd(jobId, result.content); // catches and ignores failures

// Docs / skills:
result.content ?? Read(result.path) // claimed as universally safe
```
