# The process port still collapses distinct outcomes

## What was found

Review rounds on `fix/demolition-requires-observed-death` repeatedly produced the same BLOCKING finding: a
boundary that can be uncertain answers through a type that cannot express uncertainty, and a caller reads
the missing third answer as proof. A fatal escaping through a rejected
promise; a reap that signalled and could not confirm, throwing; an unobservable identity escaping as an
internal error; abandonment reported as a completed abort across registries; `gracefulKill` fired at a live
child followed by a throw; a handoff cleanup returning `void` that its caller read as
confirmed absence; a daemon disposal typed `Promise<void>` discarding the health snapshot it was handed.

The chokepoint that should have prevented this already exists. `ProcessPort` owns the primitives,
`no-domain-ambient-io` bans raw `node:child_process` across the domains, and `signal-authority` scans the
tree for `process.kill`. **None of the findings came from bypassing that owner.** They came from the owner
itself answering two ways at several members, so callers re-derive the third answer by hand and disagree:

- `readProcessIncarnation(): ProcessIncarnation | null` — `null` means absent, unreadable, or no probe, so the
  return value alone cannot distinguish the disposition.
- `kill(): boolean` — collapses ESRCH (decisive absence), EPERM (alive and unsignalable) and every other
  errno into `false`. `gracefulKillByPid` names the collapse in a literal: `reason: 'kill-port-returned-false'`.
- `spawn(): ChildProcessLike` — launch failure arrives later on the child's `'error'` event, so callers each
  re-implement the listener-first race.

The batch form of the identity question already has the union the single form lacks:
`ProcessIdentityObservation['evidence']` is `incarnation | pid-absent | unobservable(cause)`.

## What was done

The gate, not the cure. `tests/invariants/process-observation-composition.test.ts` resolves types through the
TypeScript checker rather than matching identifier names — the earlier per-shape invariants are evaded by a
rename or by receiving a primitive as an injected parameter, which this tree already does — and enforces the
contract: the owner's members may not answer with a bare boolean, a nullable, or nothing; a function carrying one
of the registered vocabularies may not answer with a boolean or nothing, nor throw from a branch that has just
discriminated a non-first answer; the registry is fingerprinted; and the boundaries not yet converted sit in a
self-pruning ledger. `src/provider-proxy` was added to the ambient-IO ban's roots, which cost nothing because
it had no raw imports to lose.

**The ledger is the migration list.** It holds the boundaries this entry is about, each with a written reason,
and an entry that would now pass fails the test — so the list can only shrink.

The collection-state question no longer has two spellings. Runtime launch cleanup used
`exitCode !== null || signalCode !== null`, while provider-host draining supplied transport `isClosed` as
`hasExited`; `isClosed` can lag collection while an inherited pipe remains open and can also be set by
detachment. `LiveChildAuthority` is now minted only from `ChildProcessLike`, and its `hasExited()` reads the
child's collection fields. Numeric own-child signalling consumes that brand, so transport closure can no
longer type-check as collection evidence. `isClosed` remains the transport-state answer where that is the
question being asked.

`gracefulKill` is no longer part of the migration. It returns `GracefulKillDisposition`, and its callers must
handle signal refusal or failure separately from pending settlement.

## What remains

Fix `ProcessPort.readProcessIncarnation`, `ProcessPort.kill`, and `ProcessPort.spawn`. The move is
compiler-driven: the call sites break and are converted mechanically, the repeated spawn-race handling
collapses into the port, and `SettlementConfirmation` in `src/obligation/settlement.ts` gains the third answer
at the seam where observation enters settlement — a
task that observed *alive* and one that observed *unknown* both arrive today as `confirmed: false` with the
argument in a string rather than the type. The sibling `src/infra/process-*.ts` files are the §7
subdivision trigger and become `src/infra/process/`.

When that lands, delete what it makes redundant: the bare-`safeKill` half of
`timeout-kill-escalation` once `safeKill` is unexported, keeping its
signal-sequence half, which is a different invariant. Also remove the `'kill-port-returned-false'` reason
literal and `observeRecordedTarget`'s private `unobservable` spelling of the shared `unknown` concept.

## Why the process-port reshape remains deferred

A tri-state `ProcessPort.kill()` would classify the result of signalling a number; it would not make the
number's identity stable between observation and delivery. Recovered durable identities still require an
incarnation check immediately before signalling, while own-child delivery can use the stronger uncollected
handle authority. The identity-atomicity finding therefore closes without reshaping these remaining members.
The reshape remains useful for making uncertain outcomes explicit, but it is a separate answer-semantics task,
not a prerequisite for closing the signal-authority defect.

## What this will not fix

Classification stays a per-site judgement: the type forces *a* remainder, never the right one — `process-exit`
against `none` was decided by hand for the KB daemon and will be again. Cross-version compatibility (§10) and
documentation drift are different axes. And a brand proves *an* observation was decisive, not that it was
this subject's: `ProcessContainmentEvidence` carries a receipt string compared at the call site, so
"evidence for the exact obligation it discharges" remains something a reader checks.
