# TODO — provider-proxy acquisition fails on a start-time disagreement

**Status**: open. **Rewritten 2026-08-15 — the previous version of this document had the wrong cause.**
It recorded a silent-abandonment hypothesis built on the absence of a log line. A log line existed; the
earlier search simply predated it appearing.

## What was actually observed

```
WARN Provider proxy set acquisition failed for codex (…):
guardian identity disagreement on processStartedAtSeconds:
this acquisition issued 1786780788, the process reported 1786780791.
```

Three seconds apart. The check is `assertIdentityFieldsAgree`
(`src/coordinator/live/provider-proxy/role-control.ts:167-179`, comparison at `:173`): an acquisition
issues an expected identity and compares every field against what the spawned process reports; any
disagreement — `processStartedAtSeconds` included — throws and fails the acquisition.

Acquisition is therefore **attempted, logged, and failed** — not silently skipped. When it fails the
route stays absent, `routeAppServerOperation` returns `null`, and every operation takes the
`local-authorized` fallback. The coordinator keeps working without the isolation the proxy exists to
provide.

## What the previous version got wrong, and why it matters

It claimed the coordinator never attempted acquisition, reasoning from an empty log. That inference was
unsound in a specific way worth keeping: **a successful acquisition also logs nothing**, so absence of a
log distinguished nothing. The hypothesis then pointed at `already-represented` — a genuinely silent
branch, and a real reporting gap — but not at what was happening here.

Two things survive from that version and remain true:

- `ensureProxySetFor` (`src/coordinator/live/provider-hosts/index.ts:334-368`) reports only the
  `capacity` refusal (`:346-350`). Every other non-accepted admission returns silently, and so does the
  earlier `routeFor(identityKey) !== null` short-circuit at `:341`. That is still a reporting gap worth
  closing, and it is why the real cause took a second incident to surface.
- `ProviderProxySetLifecycleSnapshot` already computes `startupDiscoveryCompleted`, `represented`,
  `available` and `states` (`src/coordinator/services/provider-proxy-set/index.ts:140`, produced by
  `snapshot()` at `:577`), and has **no production consumer** — its only readers are in
  `tests/unit/coordinator/services/provider-proxy-set-lifecycle.test.ts`, a unit test, not an
  integration test as an earlier revision said. The observability this needs is already built and
  unpublished.

## The defect

A start time compared for exact equality across a spawn is not a stable identity. The acquisition issues
its expectation before the process exists; the process reports its own start afterward. Any delay
between those two moments that crosses a second boundary — a slow spawn, a loaded machine, a cold
filesystem — makes them disagree, and the acquisition fails.

### Confirmed: the same defect as the upgrade takeover, and it is not the spawn

**Root cause established 2026-08-15 and fixed for the coordinator's own paths.** `probeProcessStartedAtSeconds`
(`src/infra/node-process.ts:74-99`) returns `/proc/stat` btime plus the process's start ticks, and btime
is **cached per process** (`:16`, module-level). Every value a process derives is therefore consistent
with its own other values forever, and inconsistent with another process's by roughly the age gap
between their first reads.

So the number is not a timestamp. It is a **process-local pid disambiguator rendered in seconds**, and
its only sound operation is equality against a value derived in the same process. That is exactly what
`assertIdentityFieldsAgree` does not do: the acquisition issues a value it derived, and the spawned role
reports one it derived.

Source proves btime is cached per process. It does **not** prove that any two processes must differ, nor
that the difference equals the older process's age — that is the most plausible reading of the measured
series, not something the code establishes. Treat it as the leading hypothesis, and note that this
document has twice been burned by promoting a plausible reading to a cause.

The identical mistake, in `probeCoordinator`, made an installed upgrade unable to take over at all; that
half is fixed under `build-identity-and-upgrade.md`. The remaining pairs, enumerated rather than sampled:

| Comparison                                                            | Sites                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| parent's probe at spawn vs guardian self-report                       | `acquisition-steps.ts:354` compared at `role-control.ts:173` |
| proxy self-report vs guardian-observed containment held by the reaper | `acquisition-steps.ts:385` vs `reaper.ts:191`                |
| guardian-reported containment vs proxy self-report during inheritance | `inheritance.ts:491`                                         |
| successor coordinator's probe vs role-reported durable identity       | `inheritance.ts:291`, then `process-containment.ts:150`      |
| predecessor coordinator's durable CLI evidence vs successor's probe   | `durable-transport.ts:81` vs `carrier-observation.ts:79`     |

The last three **fail open**: a readable mismatch is interpreted as absence, so a live process group is
declared gone, never signalled, and can be issued a disappearance receipt while it is still running.
That is the more dangerous direction and it is not what the measured acquisition failures show — those
fail closed. Both come from the same primitive.

**One of them is fixed**: `inheritance.ts:295` no longer requires an exact match to conclude an enforcer
might be live — a readable start time already proves the pid exists, and whether it is still _ours_ is
what a successor cannot tell. Reproduced first: without the fix that function returns a disappearance
receipt for a set whose enforcers are alive.

### What is left here is a design question, not a repair

`observeContainment` (`infra/process-containment.ts`) reads a mismatch as absence, and **for its
original caller that is correct**: the reaper recorded the value itself, so a disagreement really does
prove the recorded leader is gone. The same function is also reached by a successor coordinator that
recorded nothing, and for that caller the identical inference is unsound.

Widening its result to `present | absent | unverifiable` was tried and reverted. It fails closed
everywhere by construction — both decisions are positive matches — but it also destroys the sound
conclusion the recorder is entitled to, and the coordinator-local recycled-group case regressed from a
clean reap into a hard error.

So the question is: **how does a process that did not record a containment prove its absence?** Options
worth weighing: pass the recorder's identity so the module can tell which caller it has; ask the reaper
over the control protocol it already speaks; or accept that a non-recorder may only ever quarantine a
containment as unreapable, never retire it. This needs a decision before code.

The redeem path is **half** right, and the half matters. Its three `establishControl` calls pass
`expectedIdentity: {}` (`inheritance.ts:390,415,445`) and compare nothing, because the capsule secret is
the authority — that is the pattern the fresh acquisition path should have copied. But the same function
then compares `containment.processStartedAtSeconds !== proxyIdentity.processStartedAtSeconds`
(`inheritance.ts:491`), guardian-observed against proxy self-report, which is the defect again.

An earlier revision of this entry called the redeem path simply correct. It is not, and the two halves
sit forty lines apart in one function.

### The observed spread is much wider than a spawn, and that changes the suspect

Thirty-one failures on one daemon over four hours, with disagreements of **2, 3, 42, 85, 91, 123, 171,
234, 236, 325, 349, 373, 375, 402, 404, 406, 410, 497, 533, 545, 550, 567, 576, 585, 629, 634 and 670
seconds** — a snapshot taken 2026-08-15, not a bound. The same daemon later recorded 716 and 729. The earlier revision of this document generalised from a single three-second sample and
called spawn latency the cause. Two seconds is a spawn crossing a boundary. **Six hundred is not.**

A spread that reaches eleven minutes points at the two sides deriving the value from different clock
bases rather than at either side being slow. `probeProcessStartedAtSeconds` converts a per-process tick
count into an absolute time using a boot reference; if that reference moves — WSL2 suspend/resume is the
obvious local candidate, and this host is WSL2 — every process started before the move reports a start
time in a different frame from one computed after it. That would produce exactly this: a roughly
constant offset within a run, drifting across runs, unrelated to load.

Which means fix option 1 below is not merely preferable, it may be the only one that works: comparing
two values read the same way is well-defined even when the clock base moves, and comparing an issued
value against a read one is not.

This is the most plausible explanation for the machine-to-machine divergence that has been read as
environment weirdness: a fast machine acquires, a slow one does not, on the same build.

## What has to be decided

1. **What identity a spawned role actually has.** If `processStartedAtSeconds` is meant to prove
   "this is the process I spawned, not a recycled pid", then it must be _read from the process_ on both
   sides rather than _issued_ by one side and checked against the other. Compare what the acquisition
   issues against how the reaper and guardian obtain the same field.
2. **Whether disagreement should fail the acquisition at all**, or retire the attempt and retry. A
   failed acquisition currently costs the coordinator its proxy for the rest of its uptime unless
   something else triggers `ensureProxySetFor` again.
3. **Publishing the snapshot** through `backend status`, so the condition is visible without reading a
   log that has already scrolled. This is independent of 1 and 2 and can land first.

## Explicitly out of scope

This does not change the local-authorized fallback, the control protocol, the containment model, or
#308's authority-fault classification.

## Start condition

Reproduce the disagreement deliberately before changing the comparison. The document has already been
wrong twice about this cause — once inferring silent abandonment from an absent log, once generalising
spawn latency from a single sample — so a reproduction is the entry price, not a formality.

That start condition is **partly** met: the mechanism is established from source, and the coordinator
half is fixed and regression-tested. What is still missing is a reproduction of two live processes
reading different clock bases — the tests injected the offset rather than producing it. The two sides do not share a clock base, and a
reproduction is a clock read in a second process, not a slow spawn.

What remains is to apply the same rule here that the coordinator paths now follow: **compare a process
start time only against a value observed in the same process**. For an acquisition, the value the parent
observed at spawn is the one that matters, because the parent is the process that will reap. The role's
self-report was never the authority — the bootstrap nonce is.
