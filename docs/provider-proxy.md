# Provider proxy operations

The coordinator resolves one immutable proxy placement at world assembly. The placement owner is
`coordinator/live/provider-hosts/host-root.ts`: proxy specs use the coordinator's running bundle,
and the guardian uses its running `argv[1]` entrypoint, including development builds in `clients/build`.
The coordinator and proxy therefore compile Claude specs from the same root. Local compilation uses
the bundle-manifest owner, including source-mode guards and compiled `dist/` fallback. Local fallback
recompiles for its own placement.

`providers/host-identity.ts` owns executable keys and fingerprints for both processes. Before opening a
host, the proxy compares the compiled stable spec fingerprint with its capsule. A mismatch returns the
existing `proxy_prepare_refused` permanent refusal with `disposition: local-fallback` and reason
`provider_host_fingerprint_mismatch`. The coordinator logs it at warn; no provider host is spawned.

An invalid activation ACK becomes `provider_activation_ack_invalid` in the existing saga error fields.
The coordinator warns on its first occurrence and releases the single operation. An unpublished start
is stopped, inspected and terminalized only after confirmed `released-activation-indeterminate`.
A recorded user abort wins over permanent failure when terminalizing.

`PRE_EXECUTION_FAILURE_BOUND_MS` is 120 seconds, twice the lifecycle's 60-second reattachment span,
well beyond the 10-second semantic cancellation span and several 5-second RPC budgets. It measures
monotonic no-progress time from phase entry over decisive proxy failures (remote refusals or a stop
acknowledged without releasing an unpublished operation). Phase advancement and confirmed prepare
attempt release reset it. Missing, temporarily unavailable, reattaching and startup set authority waits
pause it; unconfirmed transport delivery does not consume it. A coordinator restart starts fresh
accounting. Retry counts remain backoff diagnostics, never destruction authority.

Exhaustion first cancels the single never-started operation and permits local fallback only on exact
`released-never-started` evidence. A possibly-started operation is stopped and inspected; confirmed
indeterminate activation ends with the named exhaustion cause. A pending semantic release retains
remote ownership. Executing and settlement-pending operations retain their retry-safe ownership.

Only failure to release that operation requests set containment, through
`ProviderProxySetLifecycle.requestOperationContainment`. It uses lifecycle route removal, mutation
fencing, named decisions, proof collection and ordinary disappearance delivery. Faultless containment
requires zero live claims. A request while claims remain records a hold whose exit is single-operation
release or a containment-qualified authority fault; it cannot destroy healthy siblings. A
`teardown-latched` authority fault still permits the lifecycle's established containment path.
Unknown observations never prove absence or finalize a job.

## Released v0.10.16/17 incumbents

Upgrading alone does **not** clean up the stuck incumbent. Both released builds expose
`coordinator.provider_proxy_set.contain.v2`, but reject an ordinary available set as `not-held`, even
when its operations have the exact `activationAck.hostRef.fingerprint` refinement error. Those errors
do not put the lifecycle into a qualifying hold. The incumbent refuses succession while these
pre-execution claims remain and cannot retire while their jobs are live. No released RPC provides the
required automatic contender cleanup, so this change does not attempt or claim it.

An affected machine needs the old coordinator stopped externally (for example by a machine restart),
then the fixed coordinator started. Stopping only the old coordinator leaves the old guardians to
apply their orphan deadline; let them confirm and reap their exact process trees before recovery
terminalizes the stale records. Do not infer process absence merely from a closed socket or missing
coordinator. The fixed reconciler recognizes the released refinement error when it actually acquires
ownership or receives ordinary confirmed disappearance; that recognition is not upgrade cleanup.

A new proxy stops `started-awaiting-publication` operations by stopping the semantic host and releasing
staging and execution. It retains `released-activation-indeterminate`, never claiming an unpublished
start was unstarted. The old proxy's ineffective unpublished stop cannot be corrected by this build.

Workflow carrier evidence comes from the workflow owner's required running set. The owner adds a job
after publishing its runtime start and removes it in a `finally` when the executor settles, including
terminal-store failures. Launch reservations do not determine workflow liveness.
