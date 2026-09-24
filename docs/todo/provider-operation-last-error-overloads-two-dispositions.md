# TODO — a provider operation's `lastError.message` is also a terminal's input

**Status**: open, recorded not fixed. Found while release re-attempts still wrote the provider-operation row;
changing the overloaded terminalization contract remains separate from that deleted bookkeeping path.

The same one-value/two-dispositions problem appears in
[`write-atomic-durable-sync-result-overloads-two-dispositions.md`](./write-atomic-durable-sync-result-overloads-two-dispositions.md)
and [`process-port-answers-with-two-values.md`](./process-port-answers-with-two-values.md).

`providerHostUnserviceableLastError` (`src/jobs/provider-operation-terminalization.ts`) builds a `lastError`
whose `message` is the literal prefix `provider_host_unserviceable:` followed by a JSON object carrying the
`hostRef` and the operator remediation. `terminalizeProviderOperation` parses it back out of that same string
when the pending directive's `code` is `provider_host_unserviceable`, and emits the decoded fields as the
terminal's `detail`.

So one field holds two dispositions at once: **the diagnostic of the last failed attempt**, and **an input the
terminal this record is still waiting for will read**. That is what `design-philosophy` principle 11 names when
it says not to overload one value with two dispositions, and it has a cost every writer pays. The remaining
failed-attempt writer, `#recordRetry` (`src/coordinator/services/provider-operation-reconciler.ts`), calls
`preservesHostRefusalEvidence` before touching `lastError`; another writer that forgets the guard silently
destroys the evidence its own terminal needs. The guard is invisible from the field's own type: `lastError`
is `{ observedAtMs, code, message }` and nothing in that shape says one `code` value makes `message`
load-bearing.

The fix is to give the terminal input its own home on the record rather than a prefix inside a diagnostic
string, so a failed attempt can overwrite `lastError` unconditionally. Two things gate it:

- `providerOperationRecordSchema` is `.strict()` and its version is the address its rows live at, so a new
  field is additive under principle 10 but must be read tolerantly by the build that does not know it. A
  record written by a newer coordinator is read by an older one for as long as that daemon lives.
- The guard is currently load-bearing in production. Until the new field exists, deleting
  `preservesHostRefusalEvidence` is a real defect, not a cleanup — it remains pinned on `#recordRetry`.
