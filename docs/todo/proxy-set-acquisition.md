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
(`src/coordinator/live/provider-proxy/role-control.ts`): an acquisition
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

- `ensureProxySetFor` (`src/coordinator/live/provider-hosts/index.ts`) reports only the
  `capacity` refusal. Every other non-accepted admission returns silently, and so does the
  earlier `routeFor(identityKey) !== null` short-circuit. That is still a reporting gap worth
  closing, and it is why the real cause took a second incident to surface.
- `ProviderProxySetLifecycleSnapshot` already computes `startupDiscoveryCompleted`, `represented`,
  `available` and `states` (`src/coordinator/services/provider-proxy-set/index.ts`, produced by
  `snapshot()`), and has **no production consumer** — its only readers are in
  `tests/unit/coordinator/services/provider-proxy-set-lifecycle.test.ts`, a unit test, not an
  integration test as an earlier revision said. The observability this needs is already built and
  unpublished.

## The defect

A start time compared for exact equality across a spawn is not a stable identity. The acquisition issues
its expectation before the process exists; the process reports its own start afterward. Any delay
between those two moments that crosses a second boundary — a slow spawn, a loaded machine, a cold
filesystem — makes them disagree, and the acquisition fails.

### Confirmed: the same defect as the upgrade takeover, and it is not the spawn

**Root cause established 2026-08-15, and the primitive is fixed everywhere it was read — including at
this acquisition's own comparison.** The primitive was `probeProcessStartedAtSeconds`, which returned
`/proc/stat` btime plus the process's start ticks, over a module-level btime cache. Every value a process
derived was therefore consistent with its own other values forever, and inconsistent with another
process's by roughly the age gap between their first reads. It no longer exists: #324 deleted it
repo-wide, and `src/infra/node-process.ts` now carries an opaque `ProcessIncarnation` that is comparable
only against a value derived in the same process — the paragraph below is why. #324 renamed the field at
this acquisition's own `expectedIdentity` site too (`src/coordinator/live/provider-proxy/acquisition-steps.ts`, compared at
`src/coordinator/live/provider-proxy/role-control.ts`), so the disagreement quoted above — one that grows with the incumbent's age —
cannot recur there on any supported platform: no probe caches a clock reading across calls anymore, which
is what made one process's derived value drift from another's fresh one. Past tense in the rest of this
section is deliberate; nothing else here describes code that is still in the tree.

So the number is not a timestamp. It was a **process-local pid disambiguator rendered in seconds**, and
its only sound operation was equality against a value derived in the same process. That is exactly what
`assertIdentityFieldsAgree` did not do: the acquisition issued a value it derived, and the spawned role
reported one it derived. What #324 did not change is that shape of comparison — it still checks a value
the acquisition derived by probing the spawned pid against a value the role separately derives and
self-reports at open time. That is sound on Linux, where the token is boot-relative; the narrower,
already-tracked exception is Darwin, where the token is wall-clock-based
(`docs/todo/darwin-signal-authority.md`). Whether to keep that cross-process shape at all is taken up
under "What has to be decided" below — a design question the fix left standing, not the clock-drift bug.

**Measured, not inferred — and the earlier framing here was wrong.** btime is not cached by the kernel;
it is recomputed on every read as `realtime_now - boottime_now`. The per-process constancy was entirely
Coral's own module-level cache. On this host `CLOCK_BOOTTIME` runs slow against
`CLOCK_REALTIME`, so btime climbs: **3 seconds in 23 seconds of wall time, 13.5%**. A four-hour-old
daemon is therefore ~1900 seconds away from a fresh reader.

So the spread below is not noise and not spawn latency. It is **the incumbent's age times the drift
rate**, which is why it grew monotonically and why the maximum kept rising as the daemon aged.

What the probe actually computes is `(realtime_now - boottime_now) + startTicks/HZ` — the identity plus a
noise sample taken at probe time, with no record of which sample was used.

The identical mistake, in `probeCoordinator`, made an installed upgrade unable to take over at all; that
half is fixed under `build-identity-and-upgrade.md`. The remaining pairs, enumerated rather than sampled:

| Comparison                                                            | Sites                                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| parent's probe at spawn vs guardian self-report                       | `src/coordinator/live/provider-proxy/acquisition-steps.ts` compared at `src/coordinator/live/provider-proxy/role-control.ts` |
| proxy self-report vs guardian-observed containment held by the reaper | `src/coordinator/live/provider-proxy/acquisition-steps.ts` vs `src/provider-proxy/reaper.ts`                                 |
| guardian-reported containment vs proxy self-report during redemption  | `src/coordinator/live/provider-proxy/control-redemption.ts`                                                                  |
| successor coordinator's probe vs role-reported durable identity       | `src/coordinator/live/provider-proxy/control-redemption.ts`, then `src/coordinator/services/provider-proxy-set/inheritance.ts` |
| predecessor coordinator's durable CLI evidence vs successor's probe   | `src/coordinator/live/durable-transport.ts` vs `src/coordinator/composition/carrier-observation.ts`                          |

The last three **fail open**: a readable mismatch is interpreted as absence, so a live process group is
declared gone, never signalled, and can be issued a disappearance receipt while it is still running.
That is the more dangerous direction and it is not what the measured acquisition failures show — those
fail closed. Both come from the same primitive.

**One of them is fixed**: `src/coordinator/services/provider-proxy-set/inheritance.ts` no longer requires an exact match to conclude an enforcer
might be live — a readable start time already proves the pid exists, and whether it is still _ours_ is
what a successor cannot tell. Reproduced first: without the fix that function returns a disappearance
receipt for a set whose enforcers are alive.

### The reaper is a fourth cross-frame site, not the entitled recorder

An earlier revision of this entry, and of the fix that shipped with it, assumed `observeContainment`'s
mismatch-means-absent inference was sound for "the recorder". Traced, the recorder is not who it looked
like: the **guardian** probes at spawn (`src/provider-proxy/role-spawn.ts`), arms its own enforcer with that value —
genuinely sound, same frame — and then **forwards the identical value** to the reaper
(`src/provider-proxy/guardian.ts`). The reaper stores it (`src/provider-proxy/reaper.ts`) and compares it against **its own** probes.

It has not been seen failing only because guardian and reaper are born milliseconds apart, so their
cached samples nearly agree. That margin degrades linearly with the drift rate.

The one genuinely same-frame caller is the coordinator-local drain — record in
`providers/app-server-transport.ts`, reap in `live/provider-hosts/drain.ts`, one process. That is what
`drain.test.ts` protects, and it is the only one.

### Still open on `main`: a disappearance receipt for a live orphaned group

Guardian and reaper both dead while the detached proxy group survives — a real topology, since the proxy
outlives its parents by design. `enforcerMayStillBeLive` is false, `observeContainment` reads the
cross-frame mismatch as absence **without ever probing `-processGroupId`**, `confirmAbsence` re-reads the
same mismatch and agrees, the reap returns cleanly, and a disappearance receipt is minted for a live
group that nothing will ever signal.

### Shipped: the primitive is now an opaque token

`processStartedAtSeconds` is gone. `ProcessIncarnation` is a branded string: `linux:<boot_id>:<startTicks>`
on Linux, with no clock term, no `HZ` division and no `Math.floor` — boot-relative and, per
`incarnationMayAuthorizeSignal`, collision-safe. macOS and Windows instead brand a creation timestamp read at
probe time (`ps -o lstart=` parsed by `Date.parse`, and WMI's `CreationDate`, respectively) together with a
boot-session identifier. That closes the across-reboot half on every platform and closes the drift-with-age
bug quoted at the top of this entry everywhere too, because no probe caches a reading across calls anymore —
but it does not make every comparison in the table above sound on every platform: Darwin's token is still a
moving-clock reading, and the DST/NTP collision window that leaves open is tracked separately
(`docs/todo/darwin-signal-authority.md`).

The brand is the enforcement, and it earned that on the first compile: `process-containment.ts` was
found doing `identity.incarnation < 0`, an ordering on an identity, which a string simply cannot express.
An invariant test (`tests/invariants/process-incarnation-opacity.test.ts`) is the backstop for the one
thing the type cannot catch — a module rebuilding an absolute timestamp from `/proc/stat` btime.

Deleted with it: btime parsing and its cache, `HZ` parsing and its cache, the `getconf` subprocess, and
the `CORAL_DISCOVERY_PROBE_CLK_TCK` environment variable with its row in `docs/configuration.md`.

### Why the primitive was the answer, and the question dissolved

`observeContainment` (`infra/process-containment.ts`) reads a mismatch as absence, and **for its
original caller that is correct**: the reaper recorded the value itself, so a disagreement really does
prove the recorded leader is gone. The same function is also reached by a successor coordinator that
recorded nothing, and for that caller the identical inference is unsound.

Widening its result to `present | absent | unverifiable` was tried and reverted. It fails closed
everywhere by construction — both decisions are positive matches — but it also destroys the sound
conclusion the recorder is entitled to, and the coordinator-local recycled-group case regressed from a
clean reap into a hard error.

The question "how does a non-recorder prove absence?" presupposes that recording confers epistemic
privilege. It does not — **sharing a frame does**, and the recorder merely shares a frame with itself.

Replace `processStartedAtSeconds` with an opaque, equality-only `ProcessIncarnation`: on Linux
`boot_id:startTicks`, with no clock term, no `HZ` division and no `Math.floor`; on macOS and Windows the
kernel-stored creation stamps those platforms already expose. `startTicks` alone is not enough — after a
reboot a durable `pid=1234, ticks=500` can genuinely match a fresh low-pid process, a false _match_ at
exactly the pids reused earliest in boot. `boot_id` closes that structurally.

Then every site above becomes sound at once, `src/coordinator/services/provider-proxy-set/inheritance.ts` becomes a real cross-check, and the
`enforcerMayStillBeLive` softening shipped alongside this entry can be deleted in favour of the stronger
comparison it replaced.

**The build gate makes the wire half atomic.** `assertNamedCoordinatorBuild` (`src/provider-proxy/protocol.ts`) requires
`buildSetId` equality and gates handoff-redeem on guardian, proxy and reaper, so a new build can never
redeem an old build's live set. No negotiation and no compatibility window is needed for the control
protocol — only for the two surfaces that genuinely span builds: the journal's `durable_cli_process.v1`
meta, and durable provider-operation records read when role control is unavailable. For those, write the
token as a **new field and let its absence be the signal**: a legacy record carries a number with no
frame, was never comparable, and must fail closed into quarantine rather than be translated.

The rule then lives in the **type**. A branded string admits no arithmetic, no ordering, and no
"within 3 seconds", so the only expressible operation is the sound one. Prose demonstrably could not
hold it: the propagation vector was a comment naming an unsound site as "Canonical pattern". One
invariant test is the backstop, asserting `/proc/stat` btime does not return to `src/`.

Deleted along the way: btime parsing and its cache, `HZ` parsing and its cache and the `getconf`
subprocess, the `CORAL_DISCOVERY_PROBE_CLK_TCK` environment variable and its row in
`docs/configuration.md`, and the floor that made 1-second aliasing possible.

The redeem path's three role-control calls leave the per-call `expectedIdentity` empty, then
`src/coordinator/live/provider-proxy/control-redemption.ts` compares every role's complete reply with the set
identity after all three calls answer. The capsule secret authenticates the holder; it does not excuse an
identity disagreement.

The later comparison (`src/coordinator/live/provider-proxy/control-redemption.ts`, guardian-observed containment against proxy
self-report) is a **different thing, and it is correct in intent**: an independent cross-check between
two views of one containment. An earlier revision of this entry called it "the defect again". It is not.
The check is sound; the primitive underneath it is not, and under a comparable primitive the check
becomes valuable rather than deletable.

### The observed spread is much wider than a spawn, and that changes the suspect

Thirty-one failures on one daemon over four hours, with disagreements of **2, 3, 42, 85, 91, 123, 171,
234, 236, 325, 349, 373, 375, 402, 404, 406, 410, 497, 533, 545, 550, 567, 576, 585, 629, 634 and 670
seconds** — a snapshot taken 2026-08-15, not a bound. The same daemon later recorded 716 and 729. The earlier revision of this document generalised from a single three-second sample and
called spawn latency the cause. Two seconds is a spawn crossing a boundary. **Six hundred is not.**

A spread that reaches eleven minutes points at the two sides deriving the value from different clock
bases rather than at either side being slow. The primitive converted a per-process tick
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

1. **Whether the acquisition should keep comparing a value it derived against one the role separately
   derives and self-reports.** The disagreement this entry was opened for cannot recur on any platform,
   because `ProcessIncarnation` no longer accumulates drift across a process's own age the way
   `processStartedAtSeconds` did (see "Confirmed" above) — but the shape is still cross-process, and the
   alternative is to read the identity the same way on both sides: re-probe the connected pid itself once
   open, and drop the self-report. Redemption cannot supply that precedent: its per-role selector starts
   empty, but the redemption owner then verifies the complete returned identity against its exact target.
   This is a design choice now, not a bug fix.
2. **Whether disagreement should fail the acquisition at all**, or retire the attempt and retry. A
   failed acquisition currently costs the coordinator its proxy for the rest of its uptime unless
   something else triggers `ensureProxySetFor` again.
3. **Publishing the snapshot** through `backend status`, so the condition is visible without reading a
   log that has already scrolled. This is independent of 1 and 2 and can land first.

## Explicitly out of scope

This does not change the local-authorized fallback, the control protocol, the containment model, or
#308's authority-fault classification.

## Start condition

The reproduction this section used to ask for is no longer obtainable, and that is a resolution, not a
gap: the disagreement quoted at the top of this entry was two values derived from the same moving clock
at different moments, and #324 removed that moving-clock primitive from both sides of the comparison,
repo-wide, including at this acquisition's own `expectedIdentity` site. On Linux — the platform the
quoted disagreement was observed on — neither side reads a clock at all anymore, so there is no
clock-base divergence left to produce there. Darwin's token is still a clock reading taken at probe time
(see "Shipped" above), which is the DST/NTP collision window `docs/todo/darwin-signal-authority.md`
tracks separately, not the bug this entry is about. Sending an engineer to reproduce "two live processes
reading different clock bases" against current code is chasing a symptom the fix already closed on the
platform it was observed on.

What is left to decide is item 1 above, and its entry price is reading `assertIdentityFieldsAgree` and
the two probes that feed it (`src/coordinator/live/provider-proxy/acquisition-steps.ts`, `src/provider-proxy/role-main.ts`), not reproducing a failure.
The role's self-report is checked against the acquisition's own probe rather than trusted outright, which
is sound on Linux; whether that is the shape to keep, or whether the acquisition should re-probe the
connected pid itself the way the redeem path does, is the open question — not whether the two sides can
still disagree by minutes.
