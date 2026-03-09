# HTTP Scope Preflight Must Preserve Missing-Job Semantics
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When an HTTP entrypoint enforces `projectRoot` scope with `ProgressStore.scopedLookup()`, reject `mismatch` before dispatch, but keep `missing` IDs on the normal code path when the downstream contract already reports them. For abort, "valid" means "not mismatched", so missing IDs still surface in `AbortResult.notFound`; for wait, reject only when every requested job is missing, and allow found/missing mixes to proceed.
## Why
If a preflight collapses `missing` into "invalid", it silently changes the API contract: abort stops reporting `notFound`, and wait starts rejecting requests that should remain resumable while a job is starting or while callers include stale IDs beside real ones. Scope enforcement belongs at the boundary, but it must preserve the pre-existing missing-job semantics behind that boundary.
## Pattern
```ts
// Right: reject cross-project access, preserve missing-job behavior.
const check = scopeCheckJobs(jobIds, projectRoot);
if (check.mismatch.length > 0) {
  return forbidden('scope_mismatch');
}

return abortJobs(check.valid); // includes found + missing
```

```ts
// Wrong: filtering to found jobs erases the downstream notFound contract.
const foundOnly = jobIds.filter((jobId) => scopedLookup(jobId, projectRoot) === 'found');
return abortJobs(foundOnly);
```
