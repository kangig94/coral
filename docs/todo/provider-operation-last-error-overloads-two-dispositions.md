# TODO — a provider operation's `lastError.message` is also a terminal's input

**Status**: open, recorded not fixed. Found while giving the release re-attempt a durable witness; changing it
there would have widened that change into the terminalization contract.

`providerHostUnserviceableLastError` (`src/jobs/provider-operation-terminalization.ts`) builds a `lastError`
whose `message` is the literal prefix `provider_host_unserviceable:` followed by a JSON object carrying the
`hostRef` and the operator remediation. `terminalizeProviderOperation` parses it back out of that same string
when the pending directive's `code` is `provider_host_unserviceable`, and emits the decoded fields as the
terminal's `detail`.

So one field holds two dispositions at once: **the diagnostic of the last failed attempt**, and **an input the
terminal this record is still waiting for will read**. That is what `design-philosophy` principle 11 names when
it says not to overload one value with two dispositions, and it has a cost every writer pays. Every path that
records a failed attempt has to carry the same guard — `#recordRetry` and `#recordReleaseAttempt`
(`src/coordinator/services/provider-operation-reconciler.ts`) both call `preservesHostRefusalEvidence` before
touching `lastError` — and a third writer that forgets it silently destroys the evidence its own terminal
needs. The guard is invisible from the field's own type: `lastError` is `{ observedAtMs, code, message }` and
nothing in that shape says one `code` value makes `message` load-bearing.

The fix is to give the terminal input its own home on the record rather than a prefix inside a diagnostic
string, so a failed attempt can overwrite `lastError` unconditionally. Two things gate it:

- `providerOperationRecordSchema` is `.strict()` and its version is the address its rows live at, so a new
  field is additive under principle 10 but must be read tolerantly by the build that does not know it. A
  record written by a newer coordinator is read by an older one for as long as that daemon lives.
- The guard is currently load-bearing in production. Until the new field exists, deleting
  `preservesHostRefusalEvidence` is a real defect, not a cleanup — it is pinned by tests at both writers.
