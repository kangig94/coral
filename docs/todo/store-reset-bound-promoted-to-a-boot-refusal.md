# TODO — a store-reset bound became a boot refusal, three times

**Status**: design settled 2026-09-12, implementation in flight. This document is the specification.

A coordinator refused to start because the store was too large to *report on*. Recovering it needed a
plugin rollback by hand. The design below removes that refusal, and the review that produced it found
the same mistake twice more in its own drafts, so the rule it ends with is worth more than any of the
mechanisms:

> In `openOrResetBackendStoreDb`, every observation selects a **mechanism**. None of them selects a
> **refusal**. Only a genuine filesystem failure may stop the boot.

## What happened

`src/store/schema.sql` changed between `v0.10.9` and `main`, so the DDL fingerprint moved, so a 0.10.10
build classified an existing store `older-incompatible` and took the automatic-reset path. Publication
copies each evidence file while hashing it, against a budget seeded from `MAX_REPORT_HASH_BYTES`
(1 GiB). The store measured 1,174,228,992 bytes. `copyCandidateForPublication` threw, `publishIncident`
wrapped it as `store_reset_quarantine_failed`, and the daemon did not start — on any attempt, for hours.

The remediation named an exit that was not the cause: *"Check permissions and free disk space."* The
real cause appeared only inside `startup-diagnostic.json`.

The measured facts that shape the fix, all taken on the affected machine:

- sha256 over that store: **3.99 s warm**, against the 15 s `waitForExistingIncumbentReady` deadline.
- `<dbDir>` and the quarantine root are the same device, so `EXDEV` is owed on principle, not observed.
- The quarantine root already held 237 MB across six incident directories spanning 2026-07-31 to
  2026-08-14, and `retained-active-store-transitions/` held 8 KB. Nothing prunes either.

## The budget was never a brake

`classifyStoreFormat` resets on `older-incompatible` and on `corrupt-or-unsupported`, and
`legacy-adoptable` requires version metadata *absent* alongside an identical fingerprint. So the reset is
already automatic for every store under 1 GiB. The budget vetoes on **size**, which carries no
information about whether resetting is correct, and fires only on the largest stores. Removing it does
not introduce automatic reset; it removes an accidental size-keyed veto.

It bites twice, not once: at publication and again at resume, so a crash left a second door into the
same brick.

## Design

### Preservation moves bytes instead of copying them, when it can prove it may

Publication keeps its commit boundary. Only the middle step changes:

```
today:   mkdir staging -> COPY each file (hashing) -> write manifest -> unlink actives -> rename(staging->final)
design:  mkdir staging -> LINK each file, then hash -> write manifest -> unlink actives -> rename(staging->final)
```

`link(2)` rather than `rename(2)`, because the crash-resume machinery rests on evidence existing in both
places between the copy and the unlink, and `rename` destroys that window along with the only witness
that distinguishes an interrupted publication from tampering. After `link`, the staged name and the
active name are one inode, so that question is answered by `(dev, ino)` equality — where a sha256 match
only proves "same bytes when I read them", and `existsSync(active.source)` is the `!== absent` standing
in for `=== alive` that §11 names.

`claimQuarantineArtifactCoordinate` in `src/store/handoff-routing-status-store/quarantine.ts` is the
existing production shape for this: link, re-observe both names, compare `dev`/`ino`, durable-sync the
directory, unlink the source only on an identity match. Its own comment records that `link(2)` fails
`EEXIST` instead of replacing a destination, which is how it claims a coordinate atomically.
`StoragePort.linkSync` already exists, so no port changes.

The hash is computed **after the link, through the staged name, before the active unlink**. The staged
name is the artifact the manifest describes, and the active name still exists at that moment, so a
divergence is detectable. Failure there aborts with nothing removed, which the existing
`activeRemovalStarted === false` cleanup already covers.

### The lease selects the primitive

Exclusivity does not come from the locks the reset already holds. `acquireBackendStoreResetLock` excludes
only another Coral reset. `acquireGenerationAdoptionLease` excludes neither writers nor readers —
adoption and the writer lease are different locks, and `acquireWriterLeaseUnderAdmission` probes only the
**maintenance** lock.

`acquireGenerationMaintenanceLease` is the mechanism that excludes a writer, and it already answers in
three: it takes admission then maintenance, loops `removeDeadWriterLeases` until no blocker remains, and
on timeout distinguishes `writer-live` from `writer-unobservable`. The operator discard path reaches it
through `acquireStoreRecoveryLease`. **The startup reset never calls it**, and
`recoverActiveStoreSelection` supplies the recovery lease only on its operator arm — so today startup
unlinks a live `store.db` without draining or observing anything. That is a defect independent of this
change.

Two out-of-process writable openers exist, and `tests/invariants/writable-db-coordinator-only.test.ts`'s
`EXPLICIT_ALLOWLIST` is their authoritative enumeration — a grep for one callee name misses the other:

- `src/kb-daemon/runtime-host.ts` — a separate spawned process, holding a writer lease taken through the
  generation-mutation seam.
- `src/cli/expansion/install.ts` — a separate CLI process, holding a writer lease after readiness.

Both honour the maintenance lease, so one acquisition covers both. Neither is excluded today. The KB
daemon's orphan window is real and unbounded: its parent watchdog stops only on an **observed** absence,
and its database handle closes at the end of disposal rather than the start.

The primitive follows from the lease's answer:

| Lease answer | Primitive | Cost |
| --- | --- | --- |
| drained | `link` | zero bytes |
| `writer-live` | `copy`, no budget | 2x disk, one read and one write |
| `writer-unobservable` | `copy`, no budget | same |
| `EXDEV` / `EMLINK` / `EPERM` / `EOPNOTSUPP` | `copy`, no budget | same |

`link` requires proven exclusion because its exposure is **post-commit and undetectable**: a third
party's still-open writable fd follows the inode into quarantine and keeps writing, so the manifest's
sha256 is wrong from the commit onward and the reader reports the preserved store mismatched forever.
`copy` produces a separate inode that no third party holds, and its identity bracket detects interference
while it runs. So unknown selects the mechanism whose failure is visible — one fallback arm with four
triggers, not four fallbacks.

The lease is acquired only when a reset is actually needed; a `compatible` open must not pay for it or
contend with a healthy KB daemon. Lock order is adoption, then maintenance, then the reset lock, matching
the operator path. `acquireWriterLeaseUnderAdmission` never takes adoption, so no cycle appears.

**Acquiring the maintenance lease may never make `openOrResetBackendStoreDb` throw.** The timeout selects
a primitive; it does not refuse. This is the one place the change could reintroduce the original bug, so
it is an invariant rather than a convention.

`same-inode` keeps its meaning and loses an over-claim: it is decisive for "these two names are one
file", and it is not evidence that no third party holds the inode open. An open descriptor is invisible
to `stat`, and no portable observation sees one. The bracket answers identity; the lease answers
exclusivity; conflating them is what produced the defect.

### Retention is bounded by refusing to add, never by evicting

Renaming rather than copying means every incident permanently retains a full store, and nothing prunes
the quarantine root today. A bound is required. Eviction is not the way to get it.

An incident preserves the store that was live when it fired. Reset #1 preserves everything up to `t1` and
installs an **empty** store; reset #2 preserves only `[t1, t2)`. Under retain-one-by-recency the tiny
suffix evicts the whole prefix, and two DDL-changing releases erase the history and keep the emptiness.
Recency is anti-correlated with worth here. Size and event count fare no better — the latter requires
opening a store this build cannot read, by definition.

> The quarantine root has one **preserved slot**. A reset **claims** it when vacant. When it is held, the
> reset **discards** its own evidence if that evidence is a provable descendant of the holder, and
> **preserves over the bound** when it is not. Nothing is ever deleted to make room, and nothing refuses
> to boot.

Resolution runs under the reset lock, before any staging directory exists:

1. Read the ledger. Absent or unparseable means vacant; the reader tolerates unknown keys.
2. If it names a holder whose `reset-manifest.json` is missing or unparseable, the slot is vacant and the
   next commit rewrites the ledger. This same recovery covers the crash window between commit and ledger
   write.
3. Vacant: link (or copy), commit, then set `preserved`.
4. Held: run the descent check against the holder's manifest.
   - descendant: delete the active files, write a receipt, boot.
   - unrelated or undeterminable: preserve over the bound, leave `preserved` pointing at the holder,
     increment `excess`.

**Descent check**, derivable from two manifests already on disk with no new durable field and no store
read: the live store descends from the holder's reset when its `storedFingerprint` equals the holder's
`expectedFingerprint` **and** its `storedProductVersion` is at least the holder's `build.version`. A
fingerprint change forces a reset, so nothing moves it without producing an incident, and
`raiseStoredProductVersion` bumps the version on every compatible open. An unparseable holder manifest is
`undeterminable`, and undeterminable **preserves** — never discards.

The ledger is written **after** `renameSync(staging -> final)`. A ledger naming a nonexistent holder
would suppress the next preservation; a ledger failing to name an existing incident costs one extra
directory. The asymmetry decides the order.

Retention is bounded going forward and cannot be bounded retroactively: the incident directories already
on disk were written by builds this design did not author, and nobody acknowledged them. They stay,
listed, drainable one at a time.

### The ledger

`<quarantineRoot>/store-reset-retention.v1.json`, mode `0600`, written with `writeAtomicDurableSync`. The
address is invisible to every shipped reader — `detectInterruptedIncident` descends only into `.staging`,
`listStoreResetIncidents` filters the root by `isCanonicalStoreResetIncidentId` (legacy non-UUID
directories already sit there unremarked), and the report reader opens only `<root>/<incidentId>/`.

Unlike the manifest, this record owes additive-only discipline from its first version, and its reader
tolerates unknown keys. Do **not** copy `requireExactKeys` into it.

It carries `preserved` (or null), `excess` (or null), and `discarded` (or null). `excess` and `discarded`
are a **count, a byte total, and the latest item** — never arrays. There is nothing to cap and nothing to
evict, which is what makes the bound real. Per-item history goes to the audit log: the ledger owns
current status, the audit log owns history.

`preserved` carries `readableByVersion`, projected from `manifest.build.version`. A quarantined store is
unreadable by the build that quarantined it by construction, so preserved evidence is only ever useful to
someone who installs the matching older build. A row reading *"1.17 GB, incident `bdd75824…`"* is
actionable by nobody; *"1.17 GB, readable by Coral 0.10.9"* is an instruction. This costs nothing durable
and is the highest-value output change in the design.

### Dispositions

Every variant boots. There is no refusal variant, and that absence is the invariant.

```ts
type IncidentPublication =
  | { kind: 'preserved'; incident: BackendStoreResetIncident; preservation: PreservationMechanism; retention: PreservedRetention }
  | { kind: 'discarded'; receipt: DiscardReceipt }
  | { kind: 'no-evidence' };

type PreservationMechanism =
  | { kind: 'linked' }
  | { kind: 'copied'; reason: 'cross-device' | 'writer-live' | 'writer-unobservable' };

type PreservedRetention =
  | { slot: 'claimed' }
  | { slot: 'excess'; holder: string; lineage: 'unrelated' | 'undeterminable' };

type DiscardReceipt = { resetAt: string; resetPolicyCause: StoreResetPolicyCause; evidenceBytes: number; deferredTo: string };

type StagedEvidenceObservation =
  | { kind: 'same-inode'; identity: { dev: bigint; ino: bigint } }
  | { kind: 'active-absent' }
  | { kind: 'diverged' }
  | { kind: 'undeterminable'; cause: string };
```

`StagedEvidenceObservation` is total over the crash-resume state space. `same-inode` means the crash fell
between `link` and `unlink`, so the resume unlinks the active name. `active-absent` with a
manifest-consistent staged file means the unlink completed. `diverged` has no legitimate producer under
the reset lock and maps to `store_reset_interrupted_mismatched`. `undeterminable` — a `stat` failure that
is not `ENOENT` — refuses to finalize. That last variant is the one today's code lacks: `evidenceMatches`
returns a boolean, so "I could not read it" and "it does not match" are one value.

`decision-union-results.md` scopes to `src/coordinator/`, `src/jobs/` and `src/recovery/`, so a bare
`publishIncident(...)` statement would not be caught there. Make the union impossible to ignore by
construction instead: `authorizeClassifiedStore` needs the incident to build its result and must
`assertNever` the union, so an unhandled variant is a type error.

### What the budget still bounds

`MAX_REPORT_HASH_BYTES` survives only where its name is honest — bounding **a report**. The reader
already carries the third answer for oversize (`unavailable_limit`), which is exactly why the reader
survives a 1.17 GB store while the writer does not.

- Publication seed, resume seed, and the active-versus-manifest re-hash: **removed**. The first is the
  incident; the second is the second door into it; the third is replaced by inode identity.
- Reader, both sites: **kept unchanged**.
- The two active-store-transition sites: keep the number, rehome the name
  (`MAX_ACTIVE_STORE_TRANSITION_BYTES`). They never bounded a report; inheriting the report's number was
  the original category error. **Do not shrink the value** without measuring the writer's own maximum —
  that path converts a throw into a fatal startup error, which is this same bug.

`MAX_SQLITE_DIAGNOSTIC_BYTES` is untouched and correctly scoped: it bounds a copy into `tmpdir` plus a
child process on an operator-invoked report, and returns `integrity: 'unavailable'` rather than throwing.
It is the model the other sites should have followed.

### Machine-read text

Coral's end user is not an operator. The party that reads a remediation and acts on it is a language
model, which yields three rules — and the first carries the design.

1. **Machine-read remediation may authorize only reversible actions.** Anything irreversible is a
   capability, discoverable in `--help` and in `list`, and never the answer to a failure. `release`
   deletes user data irreversibly, so no `store_reset_*` remediation may name it. Because nothing blocks
   on retention, this holds by construction rather than by discipline — and it is mechanically checkable,
   so it becomes an invariant.
2. **Prohibitions are the safe form; authorizations are not.** The existing *"Do not move, delete,
   restore, or upload DB, WAL, or SHM evidence"* is the right shape. Add nothing that reads as permission
   to touch the quarantine root.
3. **Every fact a model must relay lives in a field, not a sentence.** A model paraphrases prose wrongly
   and relays fields correctly. Which disposition occurred, whether disk doubled and why, that the bound
   is exceeded and why, what was discarded and in deference to what, and which Coral version can read a
   preserved store — all structured. `backend store-reset list` is the surface a model consults, so it
   carries `retention` and `readableByVersion` per row.

The existing `store_reset_quarantine_failed` text needs **no change**: once the budget is gone its causes
are genuine filesystem failures, and the text is then correct. What is owed is the contention arm — a
copy whose bracket aborts on a live writer should land on `store_reset_lock_contended`'s shape, whose
*"Run `coral-cli backend shutdown`, then retry shortly"* is a real, reversible exit, carrying
`reason: 'active_writer_present'` and the blocker description.

### The exit has to be built

`backend recovery-quarantine` is the wrong subsystem twice: its rows live **inside** `store.db`, the file
being reset, and it requires a live coordinator, which is absent exactly when it is needed.
`backend store-reset` offers `list`, `report` and `discard` and cannot delete retained evidence.

```
coral-cli backend store-reset release <incident-id> --target <current|gen2> --flavor <prod|dev>
```

It takes the adoption lease then the reset lock, and **must not take the operator socket guard** —
everything it must exclude is a concurrent reset, and the reset lock is that. It must be classified
`exempt`, matching `backend routing-status quarantine clear`: `makeClient()` throws on an `exempt`
resolution, so the command never touches IPC and never autostarts the coordinator. Classifying it
`mutate` would route it through the daemon and make it unreachable in precisely the situation it exists
for. It is reachable with the coordinator up, with it down, and against a store this build cannot read.

`discard` keeps its socket guard and therefore still requires the coordinator down. It is destructive to
the live store, so that is correct.

Its outcome distinguishes `released`, `not-holder` (which drains the legacy backlog), `absent`, `staged`
(uncommitted, belonging to the resume path), and `undeterminable`. `undeterminable` must **not** clear the
slot: clearing it would authorize the next reset to claim while the old bytes are still on disk.

The obligation `release` discharges is not "the operator extracted the data" — no authority computable
from output a model reads can establish that. It is **"this preserved evidence is no longer wanted"**, and
an explicit request naming the exact incident is decisive for a want. What makes the arrangement safe is
that the slot rule never needed acknowledgement: data safety comes from never evicting, and the disk
bound comes from refusing to add. Only the bound ever depended on a refusal, and only in the rare branch.

## Invariants to add

- No `store_reset_*` remediation contains `store-reset release`.
- `openOrResetBackendStoreDb`'s reset branch acquires the maintenance lease before publishing.
- Acquiring the maintenance lease cannot make `openOrResetBackendStoreDb` throw.
- On the incident path, `linkSync` precedes `unlinkSync` and every link destination is inside the staging
  directory.

`tests/invariants/store-reset-discipline.test.ts` fails any `rmSync`/`unlinkSync` whose **call text**
matches the store file names, so the discard path must be written through the candidate rather than
through `files.dbFile`.

## Blast radius

`src/store/backend-store-reset.ts` carries the largest change; `src/store/reset-retention.ts` is new.
`src/store/reset-incident.ts` gains constants only — **the manifest schema does not change**, and cannot:
`validateManifest` uses `requireExactKeys` at every level and the staging manifest is parsed on the
startup path before any authority check, so one added key means `manifest_invalid_schema` and an
unbootable coordinator for every shipped build. `files` must also be non-empty, so a manifest-only
incident is not representable.

Also touched: `reset-incident-reader.ts` (list entries gain retention and `readableByVersion`),
`active-store-selection-coordination.ts` (supply the recovery lease on the startup arm, gated on a reset
being needed), `startup-store-routing.ts` (wire the lease in), `operator-store-reset.ts`,
`cli/commands/backend.ts`, `cli/store-reset.ts`, `cli/format/store-reset.ts`, `cli/classify.ts`,
`runtime/errors.ts`. `infra/port-types.ts` and `runtime/real.ts` need nothing.

Docs describing the copy-then-unlink commit and the incident model need the link primitive, the slot, and
the release command: `docs/architecture.md`, `docs/configuration.md`, `docs/design-rationale.md`.

Tests carry the most volume. `tests/integration/store/open-or-reset.test.ts` is the big one, and its
"retains the verified copy when active evidence mutates during its final removal" case **loses its
premise** under `link` — active and staged are one file, so independent mutation is impossible. Replace it
with a diverged-inode case. The single highest-value new test asserts **link when drained, copy when a
writer lease is held**. Startup now takes the maintenance lease, so every reset case needs the
coordination root present.

Gates: `format:check`, `lint`, `typecheck:tests`, `knip`, `build`, `npm test`, `test:integration`,
`test:store-reset:integration`, `verify:store-reset-build`, `test:e2e:build`, `test:e2e:lifecycle`.
`verify:store-reset-build` verifies bundle identity probes rather than the quarantine protocol and should
be unaffected.

## Rollback behaviour

A newer build links, crashes, and the plugin is rolled back. The older build's
`reconcileCommittedEvidence` re-hashes both names, which are one inode, so both match the manifest; it
unlinks the active name and renames staging into place. **An older build resumes a linked publication
correctly.** Its only failure mode is a store exceeding `MAX_REPORT_HASH_BYTES` — on which that build is
already bricked today, so rolling back never gets worse. The ledger is invisible to it; an incident it
creates that the ledger does not name becomes one extra retained directory on the next new-build boot,
never a lost one.

## Adjacent findings, tracked separately

- **There is no store migration path, and it is the real defect behind all of this.** See
  [`no-store-migration-path.md`](no-store-migration-path.md).
- `retainActiveStoreTransition`'s oversize refusal is **fatal at startup** — the same bug class as the
  incident: a bounded-read limit on a startup path with no third answer.
- `retained-active-store-transitions/` has **no operator surface at all**, deliberately, and its count is
  unbounded in principle. Bounded in practice today at 8 KB, but a refusal there is not visible as
  durable status.
- **`retained` means three different things** across this file set — the V2 schema still readable,
  evidence kept on disk, and a provider-host hold state. This design says `preserved` for the slot rather
  than reuse the house word.
- `tests/invariants/store-reset-discipline.test.ts` forbids `quarantineStoreFiles`, a symbol absent from
  `src/`. A guard against a ghost.

## How the design was reached

Three review rounds, each of which found a real defect in the one before it, and each defect was the same
mistake in different clothing: a bound that was correct about what it measured, promoted into a veto on
booting. The size budget. Then two refusals invented to enforce retention. Then, nearly, the maintenance
lease itself.

Two process notes that generalize. The hole in the writer analysis was findable in one step from
`tests/invariants/writable-db-coordinator-only.test.ts`, whose allowlist enumerates exactly that hazard
class and whose KB-daemon entry documents its own history of evading a static scan; a grep was reached for
instead, and it missed the second writer because it filtered on one callee name. **An invariant test that
enumerates a hazard class is a better oracle than a grep, and this repository already maintained one.**
And the first draft's central authority — operator acknowledgement as the gate on deletion — did not
survive asking who reads the error message. In a product whose operator is a language model, a refusal
does not buy the deliberation it was meant to buy; it buys one extra step before the same outcome, with a
dead daemon in between.
