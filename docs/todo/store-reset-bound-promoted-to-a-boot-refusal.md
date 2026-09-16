# TODO — a store-reset bound became a boot refusal, seven times

**Status**: in flight. Thirty-three design revisions and forty unbiased tier-1 review rounds. Revision 14
replaced the premise all thirteen earlier revisions inherited; 15 onward are the corrections it earned.
Revision 27 withdraws a boundary four rounds were spent defending, and Revision 32 deletes a subsystem five
rounds were spent repairing — both on the owner’s ruling. Round 41’s architect found no blocking defect.

A coordinator refused to start because the store was too large to _report on_. Recovering it needed a
plugin rollback by hand. Removing that refusal has so far surfaced six more of the same shape, four of
them introduced by the drafts meant to remove it, so the rule matters more than any mechanism here:

> **A refusal names a refused syscall. A hold names unknown evidence that proceeding would finalize.
> A bound running out names neither, so it selects the next mechanism down — and the bottom,
> park-and-claim, has none.**

The ladders, written here so "the next mechanism down" is not the author's invention:

- **For what occupies the name**: describe it — link under proven exclusion, else copy — then **park it**.
  Park has no bound. One `rename` into an owned directory, bytes conserved, a `list` row, a `release`
  exit. Nothing is needed beneath park because park does no work that scales with what it moves.
- **For the name itself**: **link** a store minted in the quarantine onto it, then (on `EXDEV` only)
  create by path. Link has no bound: `EEXIST` is the next epoch, not a failure.

This replaces an earlier sentence — _"every observation selects a mechanism; none selects a refusal; only
a genuine filesystem failure may stop the boot"_ — which was the defect rather than the cure. It named
two categories, observations of the world and filesystem failure, and **a bound running out is neither**.
Each time, its own author reasoned that exhaustion is not an observation of the store, reached for §11's
"a bounded retry must reach a named successor", found that a documented refusal naming `store-reset
discard` is a successor that exists, and shipped the veto. Four times, in four different mechanisms. The
sentence licensed that by omission.

§11 was also read backwards. It governs the **exit from a hold**; it does not say when a hold may exist.
A hold exists only where proceeding would finalize on evidence you do not have — and parking finalizes
nothing, since every inode is conserved, named, listed and releasable. So the reset path contains no hold
at all, and a bound that stops it is a veto wearing §11's clothes. The named successor was also empty in
effect: `discard` runs the same machine in operator mode and, against a foreign re-creator, either cannot
obtain its stricter lease or obtains it and parks exactly what startup would have parked.

## What happened

`src/store/schema.sql` changed between `v0.10.9` and `main`, so the DDL fingerprint moved, so a 0.10.10
build classified an existing store `older-incompatible` and took the automatic-reset path. Publication
copies each evidence file while hashing it, against a budget seeded from `MAX_REPORT_HASH_BYTES`
(1 GiB). The store measured 1,174,228,992 bytes. `copyCandidateForPublication` threw, `publishIncident`
wrapped it as `store_reset_quarantine_failed`, and the daemon did not start — on any attempt, for hours.

The remediation named an exit that was not the cause: _"Check permissions and free disk space."_ The
real cause appeared only inside `startup-diagnostic.json`.

The measured facts that shape the fix, all taken on the affected machine:

- sha256 over that store: **3.99 s warm**, against the 15 s `waitForExistingIncumbentReady` deadline.
- `<dbDir>` and the quarantine root are the same device, so `EXDEV` is owed on principle, not observed.
- The quarantine root already held 237 MB across six incident directories spanning 2026-07-31 to
  2026-08-14, and `retained-active-store-transitions/` held 8 KB. Nothing prunes either.

## The budget was never a brake

`classifyStoreFormat` resets on `older-incompatible` and on `corrupt-or-unsupported`, and
`legacy-adoptable` requires version metadata _absent_ alongside an identical fingerprint. So the reset is
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

`copyCandidateForPublication` holds **two identity checks that are not the same check**, and only one of
them may soften. The check before any bytes move — path stat against the opened descriptor's stat — asks
whether we opened a different file than we stat'd, and it **still throws**; `open-or-reset.test.ts`'s
"fails closed when active evidence is replaced between path stat and descriptor open" targets exactly it
and must stay green unchanged. The check across the copy asks whether the source held still while we
read it, and that becomes a reported `coherence` rather than an abort.

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

| Lease answer                                | Primitive         | Cost                            |
| ------------------------------------------- | ----------------- | ------------------------------- |
| drained                                     | `link`            | zero bytes                      |
| `writer-live`                               | `copy`, no budget | 2x disk, one read and one write |
| `writer-unobservable`                       | `copy`, no budget | same                            |
| lock timeout — we could not even ask        | `copy`, no budget | same                            |
| `EXDEV` / `EMLINK` / `EPERM` / `EOPNOTSUPP` | `copy`, no budget | same                            |

The lease's failure is **caught and mapped, never propagated**. That is what makes the invariant below
mechanical rather than aspirational:

| From `acquireGenerationMaintenanceLease`              | Disposition                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| resolves                                              | `proven` — link                                                        |
| `legacy_source_not_quiescent`                         | `unproven`, `writer-live` — copy                                       |
| `legacy_source_writer_observation_unknown`            | `unproven`, `writer-unobservable` — copy                               |
| a raw admission or maintenance directory-lock timeout | `unproven`, `lock-timeout` — copy                                      |
| anything else                                         | rethrow — a genuine I/O failure, the only thing allowed to stop a boot |

```ts
type WriterExclusion =
  | { kind: 'proven'; lease: GenerationMaintenanceLease }
  | { kind: 'unproven'; reason: 'writer-live' | 'writer-unobservable' | 'lock-timeout'; blockers: string | null };
```

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

**Slot resolution** runs under the reset lock before any staging directory exists, and is a total
function of the ledger plus the root:

1. Ledger absent or unparseable — **vacant**, then adoption.
2. Ledger names holder `H` and `<root>/H/` is **absent** — **vacant**, then adoption. A missing directory
   is a decisive observation that the bytes are gone.
3. Ledger names `H` and `<root>/H/` exists:
   - its manifest parses — **held by `H`**, descent check available.
   - its manifest is missing, unparseable or unreadable — **held by `H`, lineage `undeterminable`**. An
     unreadable manifest never vacates the slot: the directory exists, so the bytes are still there, and
     the bound must keep counting them. Vacating here would let the next reset claim while the old bytes
     are still on disk, which is the error `release` refuses to make on its own `undeterminable`.
4. **Adoption**, on a vacant slot only: when exactly **one** committed incident directory exists whose
   manifest parses, adopt it as the holder. Zero, or more than one, adopts none. This is the crash window
   between `renameSync(staging -> final)` and the ledger write — on a clean root the orphaned incident is
   adopted and the ladder stays blocked; on a root carrying unaccounted legacy directories adoption
   declines, because guessing which of several to adopt is a finalization on no evidence.

Then:

- **Vacant**: link (or copy), commit, set `preserved`.
- **Held, descendant**: delete the active files, write a receipt, boot.
- **Held, unrelated or `undeterminable`**: preserve over the bound, leave `preserved` pointing at the
  holder, increment `excess`.

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

`<quarantineRoot>/store-reset-retention.v1.json`, mode `0600`, written with `writeAtomicDurableSync`.

The address is never **listed** as an incident, never **parsed** by a shipped reader, and never
**reached** by the report reader: `detectInterruptedIncident` descends only into `.staging`,
`listStoreResetIncidents` filters the root by `isCanonicalStoreResetIncidentId` (legacy non-UUID
directories already sit there unremarked), and the report reader opens only `<root>/<incidentId>/`.

It is **not** invisible to the root's entry counter. `listStoreResetIncidents` increments `consumed` and
tests `MAX_INCIDENT_ROOT_ENTRIES` before applying that filter, so the ledger occupies one of the 4,096 —
alongside `.staging`, `retained-active-store-transitions/`, and the legacy directories. Under this design
the preserved slot bounds incident directories, so the ceiling is unreachable. The cost is one entry,
stated rather than claimed away. It stays in the quarantine root because it is that root's index; moving
it to `<dbDir>` to dodge a counter would split the concept to avoid admitting a cost.

Unlike the manifest, this record owes additive-only discipline from its first version, and its reader
tolerates unknown keys. Do **not** copy `requireExactKeys` into it.

It carries `preserved` (or null), `excess` (or null), and `discarded` (or null). `excess` and `discarded`
are a **count, a byte total, and the latest item** — never arrays. There is nothing to cap and nothing to
evict, which is what makes the bound real. Per-item history goes to the audit log: the ledger owns
current status, the audit log owns history.

`preserved` and `excess.latest` carry **`storedProductVersion: string | null`** — the Coral version
recorded _inside_ the quarantined store, taken from `classification.storedProductVersion` at publication.
`raiseStoredProductVersion` bumps it on every compatible open, so it names the last build that could open
that store, which is the build to install to read it. `null` is a real third answer: the store carried no
version metadata. Incidents published by builds predating this ledger have no entry and render `unknown`
rather than a guess.

A quarantined store is unreadable by the build that quarantined it by construction, so preserved evidence
is only ever useful to someone who installs the matching older build. A row reading _"1.17 GB, incident
`bdd75824…`"_ is actionable by nobody, which is why the field exists.

It is **not** derivable from the manifest, and the obvious projection is inverted: `createIncidentManifest`
writes `build.version` from `authority.version` — the build _performing_ the reset, the one that rejected
the store — and no manifest field records the store's own version. It is not derivable at read time
either: `store-reset-discipline.test.ts` asserts the support import closure rooted at
`reset-incident-reader.ts` excludes `src/store/db.ts`, so the reader cannot classify, and routing through
the diagnostic child is worse than useless because that child returns `integrity: 'unavailable'` without
opening anything once evidence exceeds `MAX_SQLITE_DIAGNOSTIC_BYTES` — which is exactly the population
this field matters for. So the ledger gains a field. The frozen-manifest constraint is untouched.

### Dispositions

Every variant boots. There is no refusal variant, and that absence is the invariant.

```ts
type IncidentPublication =
  | {
      kind: 'preserved';
      incident: BackendStoreResetIncident;
      preservation: PreservationMechanism;
      retention: PreservedRetention;
    }
  | { kind: 'discarded'; receipt: DiscardReceipt }
  | { kind: 'no-evidence' };

type PreservationMechanism =
  | { kind: 'linked' }
  | {
      kind: 'copied';
      cause:
        | { kind: 'link-unsupported'; errno: 'EXDEV' | 'EMLINK' | 'EPERM' | 'EOPNOTSUPP' | 'other'; code: string }
        | { kind: 'exclusion-unproven'; reason: 'writer-live' | 'writer-unobservable' | 'lock-timeout' };
      coherence: 'coherent' | 'torn';
    };

type PreservedRetention =
  | { slot: 'claimed' }
  | { slot: 'excess'; holder: string; lineage: 'unrelated' | 'undeterminable' };

type DiscardReceipt = {
  resetAt: string;
  resetPolicyCause: StoreResetPolicyCause;
  evidenceBytes: number;
  deferredTo: string;
};
```

`errno: 'other'` beside the raw `code` is the third answer for an errno nobody enumerated — carried rather
than flattened. `coherence: 'torn'` is independently evidence that a writer was active. Two facts, two
fields: why linking was not used, and whether the copy is a coherent point-in-time snapshot.

### The resume splits two obligations that were one loop

Finishing the commit is about **staged** evidence. Deleting the active file is about **active** evidence.
Today they are a single loop, which is how a question about the active side became able to block a boot.

```ts
/** Whether the committed evidence is intact. Decisive, and the only producer of a refusal. */
type StagedEvidenceIntegrity = { kind: 'intact' } | { kind: 'corrupt' } | { kind: 'undeterminable'; cause: string };

/** Whether the active name is provably the file this incident published. Never blocks the commit. */
type ActiveEvidenceObservation =
  | { kind: 'same-inode'; identity: { dev: bigint; ino: bigint } }
  | { kind: 'distinct-matching' }
  | { kind: 'absent' }
  | { kind: 'unmatched' }
  | { kind: 'undeterminable'; cause: string };
```

`distinct-matching` is the variant whose absence made the first draft of this design a new instance of the
bug it removes. On the copy arm, a crash between the manifest write and the active unlink legitimately
leaves staged present, active present, contents matching, and **different inodes** — which a
`same-inode`-or-`diverged` union calls tampering and refuses to boot on.

The resume then reads:

1. Check staged integrity for every manifest file. `corrupt` or `undeterminable` take today's existing
   refusals, unchanged.
2. The commit is intact, so observe each active name:
   `same-inode` or `distinct-matching` — unlink it, then sync the directory. `absent` — nothing to do.
   `unmatched` or `undeterminable` — **leave it, and do not refuse.**
3. The completeness check over names not in the manifest is unchanged.
4. `validateStagingEntries`, `requireSameDirectory`, then rename staging into place.
5. Anything left by step 2 sets `resumeLeftActive` on the ledger entry and emits one audit event naming
   the files. Classification then runs on what remains and publishes a fresh incident if it is still
   incompatible.

`unmatched` may not refuse, because a torn copy's manifest describes the truncated artifact and can never
match a still-mutating source. Leaving the file is safe — classification is about to decide its fate
anyway — and it removes the last way an active-side question could stop a boot.

`ActiveEvidenceObservation` is produced in this order, so the cheap disqualifier carries the common case:
stat both names (a non-`ENOENT` failure is `undeterminable`); active absent is `absent`; equal
`(dev, ino)` is `same-inode` with no hashing; different inode with a differing size or mtime is
`unmatched` with no hashing; and only a different inode whose size and mtime both agree is hashed against
the manifest, yielding `distinct-matching` or `unmatched`.

`decision-union-results.md` scopes to `src/coordinator/`, `src/jobs/` and `src/recovery/`, so a bare
`publishIncident(...)` statement would not be caught there. Make the union impossible to ignore by
construction instead: `authorizeClassifiedStore` needs the incident to build its result and must
`assertNever` the union, so an unhandled variant is a type error.

### What the budget still bounds

`MAX_REPORT_HASH_BYTES` survives only where its name is honest — bounding **a report**. The reader
already carries the third answer for oversize (`unavailable_limit`), which is exactly why the reader
survives a 1.17 GB store while the writer does not.

- Publication seed and resume seed: **removed**. The first is the incident; the second is the second door
  into it. Those two are the vetoes.
- The active-versus-manifest re-hash: **retained, unbudgeted, and conditional.** The link arm never
  reaches it, because one inode answers the question outright. The copy arm reaches it only after a crash,
  and only when the inodes differ while size and mtime agree. **The budget was the veto; the hash was
  never the problem** — measured at 3.99 s per gigabyte, and the resume hashes staged and active, so
  roughly 8 s on the store that caused this. Inside the 15 s incumbent deadline with less margin than
  publication has. Measure before shipping. The rule is _identity where identity exists, content where it
  does not._
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
2. **Prohibitions are the safe form; authorizations are not.** The existing _"Do not move, delete,
   restore, or upload DB, WAL, or SHM evidence"_ is the right shape. Add nothing that reads as permission
   to touch the quarantine root.
3. **Every fact a model must relay lives in a field, not a sentence.** A model paraphrases prose wrongly
   and relays fields correctly. Which disposition occurred, whether disk doubled and why, that the bound
   is exceeded and why, what was discarded and in deference to what, and the Coral version recorded in a
   preserved store — all structured. "Install that build" is the inference and belongs to the renderer.
   `backend store-reset list` is the surface a model consults, so it carries `retention` and
   `storedProductVersion` per row.

**There is no contention arm.** A writer that cannot be drained selects the copy mechanism and is
reported through `PreservationMechanism`, never through an error — an earlier draft routed it to
`store_reset_lock_contended`, which is a boot refusal and which this document's own rule condemns. The
existing `store_reset_quarantine_failed` text needs **no change**: with the budget and the contention arm
both gone, its remaining causes are genuine filesystem failures, which is what makes the text correct.

A copy taken while a writer is live is **torn, not failed**. A copy's digest always truly describes the
copy, so the artifact and its manifest agree and the reader reports `match` — correctly, because nothing
writes to that separate inode afterward. Whether the copy is a coherent point-in-time snapshot is a
property of the evidence, recorded in the ledger's `coherence`, not a failure of the operation. A torn
copy is still nearly all of the data, and for evidence that will only ever be read forensically by an
older build, nearly all is not nothing. Discharging a _byte_ obligation on _coherence_ evidence would be
the same category error as concluding that preservation is impossible because linking is.

So `hashExactDescriptor` gains an overrun disposition and returns the bytes it actually consumed. The
link arm demands a throw — growth under a proven-drained store is a real anomaly and must not be
swallowed. The copy arm reports instead, and tolerates a short read the same way; `coherence` is `torn`
when the source overran, came up short, or changed identity across the copy.
`retainTransitionFileInStoreResetQuarantine` is content-addressed to its source identity, so it must
assert `coherent` at its own call site and keep its post-copy source re-verification.

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

## Revision 2 — the active evidence pathname gets an owner

Everything above stands. This section replaces how the active pathname is touched, because the design
above gave `ActiveEvidenceObservation` to the **resume** path only and left publication and discard
touching the active name through raw throwing calls. Two review rounds then found the same boot refusal
at four separate lines, and a targeted fix for the first one did not prevent the next three.

Counting those lines was the wrong activity. **Every site that can name an active store path is a site**,
and there are sixteen `candidate.source` references in `backend-store-reset.ts` alone. The answer is
ownership, not a fourth fix.

### The owner

`src/store/reset-active-evidence.ts` is the only module that may name `files.dbFile`, `walFile`,
`shmFile` or `formatFile`. `backend-store-reset.ts` keeps staging and the quarantine root.
`candidateForEvidence` moves there and is unexported. **`ActiveEvidence` carries an identity, not a
path** — the path cannot leave the module, so no caller can reconstruct a site.

It exposes: `enumerateActiveEvidence` (mints the identity every later step is checked against);
`openActiveEvidence` (lstat → open → fstat, returning a `StableSource` whose `reobserve()` answers
`stable | changed | absent | undeterminable`, so the copy reads through a descriptor and never sees a
path); `linkActiveEvidence` (compares the **destination** to the minted identity, not the source to the
destination — the post-link source re-stat disappears rather than being softened);
`observeActiveEvidence` taking an explicit `ActiveEvidenceExpectation` of `identity` (link, copy, discard)
or `content` (resume); and `removeActiveEvidence`, which holds the module's single `unlinkSync`,
authorized only by `same-inode` or `distinct-matching`, answering `removed | absent | left`.

### Which failures throw — the rule, stated once

At a new call site, ask which of three things is being touched:

1. **A claim** — anything the manifest will assert about the staged bytes. Minting one needs an unbroken
   identity bracket, and a frozen manifest has no field to carry a broken one, so it **throws**. Every
   such throw happens before the first active unlink, where the existing `activeRemovalStarted === false`
   cleanup makes it a refusal-to-begin with nothing moved.
2. **A name** — the active pathname _after_ the claim is minted. Present? Same inode? May I unlink?
   **A disposition, never an exception.** `ENOENT` is the answer `absent`. The name's fate always has a
   field (`coherence`, `leftActive`) and classification judges what remains.
3. **A refused mutation** — a non-`ENOENT` errno on a mkdir, write, link, rename, sync, or an unlink the
   observation already authorized. **Throws.** This is the genuine filesystem failure the governing rule
   allows, and crash-resume exists for it.

A site that fits none of the three is at the wrong layer.

`'Linked store-reset evidence changed before active removal.'` is this defect class, not an exception to
it: at removal the staged link already holds the inode and the manifest is durable, so an active-name
mismatch is a name question, and throwing leaves a staging directory that can never be resumed. No test
pins it. It becomes `left`. `PreservationMechanism.linked` gains `coherence` so a linked inode that moved
after the manifest is recorded rather than refused.

The copy arm's re-hash of the whole active file at removal also goes: `copyCandidateForPublication`
already returned the identity, and the rule is _identity where identity exists, content where it does not_.

### The discard arm shares the owner

It is the least safe arm today — it re-stats every candidate and unlinks with no identity bracket at all.
Enumeration mints the identity, `evidenceBytes` sums it instead of re-stating, and removal goes through
`removeActiveEvidence`. The obligations stay different and stay in their callers; what is shared is the
pathname operation, which has the same three answers and the same errno classification on every arm.
**The proof that it is one concept: afterwards the owner has no arm-specific branch.** A second unlink
path that destroys rather than preserves would be a second canonical home for the same syscall on the
same file.

### A left name is handled once

Publication can now leave an active name, which today it never does. Publication and resume produce the
same `leftActive` list, and `openOrResetBackendStoreDb` loops at most twice: classify, publish, and go
round again only if `store.db` itself was left. Pass 2 needs a foreign actor replacing the inode inside
the reset lock, so it is practically unreachable — but the alternative is `openStoreDatabase` refusing
with `store_schema_outdated`, which is an observation selecting a refusal. Exhausting the retry reaches
that classification's own remediation, which names `backend store-reset discard`: a bounded retry whose
successor is a command that exists.

### Retention crosses as a promise, then a claim

`storedProductVersion`, preservation cause and coherence live only in memory until after the final
rename, so a crash in the commit window loses them; and when a holder already occupies the slot a
resumed incident is never entered in the ledger at all, so bytes and counts silently go missing.

The ledger gains one additive `pending` key holding the reset time, the enumerated identities, and the
outcome it promises. It is written after the manifest is durable and before the first unlink, and cleared
by the commit write, by the failed-publication cleanup, or by reconciliation.

**`pending` is a promise, not a claim: slot resolution never treats it as the holder**, so the ordering
argument above survives intact — a ledger still cannot name a holder that does not exist. Reconciliation
is the first step of `resolveStoreResetRetentionSlot` and runs before adoption, so a committed directory
named by `pending` is promoted with its full metadata instead of being adopted with id, time and size.
A `discard` outcome commits once every name is absent or a different inode, and is otherwise left for
this boot's publication to replace under the same lock.

The staging directory is not an option for this record: `validateStagingEntries` is an exact set, so a
sidecar there makes every shipped build refuse with `store_reset_interrupted_foreign`. The ledger is the
right address and carries no mixed-window risk — `src/store/reset-retention.ts` is absent at `v0.10.9`
and on `origin/main`, so it has never shipped.

### The invariant, in three layers

The current text-regex guard is what let all four findings ship green — `candidate.source` bypasses it.

1. **Type** — `ActiveEvidence` has no path field, and `candidateForEvidence` is unexported.
2. **AST** — outside the owner, no `.walFile`/`.shmFile`/`.formatFile` access anywhere in `src/`, and
   `.dbFile` only as an argument to the classifier and the store opener. Inside the owner, exactly one
   `unlinkSync`, enclosed by `removeActiveEvidence`, in a `try` whose catch tests `isNoEntryError`.
3. **Behaviour** — record the sequence of storage calls made against an active path during a clean run of
   each arm, then re-run once per index with the file deleted, and again with it replaced by a new inode,
   asserting the boot succeeds every time. The earlier rounds were single-point injections; this sweep is
   their closure, and it is the test that would have found all four windows at once.

### Two findings from the same family, with different owners

**`release` holds a pathname where it is owed a capability.** It recursive-deletes after checking two
joined paths, never proving the quarantine root is a non-symlink directory or that the incident is a
realpath-contained child — while the read boundary already refuses a symlinked root. `assertQuarantineRoot`
and `assertContainedDirectory` move into `reset-retention.ts` and run before the removal, and the result
union gains `unsafe`, which is the read boundary's own word and distinct from `undeterminable`: a
symlinked root _is_ verified, as not ours.

**`store_product_version` stops being raw at the classifier.** Today the corrupt arm returns the
unparseable string under a field name that elsewhere means "a version", and it flows to the ledger and
into a rendered table that then advises installing it — so a value containing a newline injects a row.
The valid arms also store the raw string rather than the normalized one. The corrupt arm carries
`string | null` holding valid semver only, plus a discriminator naming why it is absent. Escaping in the
renderer would treat the symptom; §8 puts the boundary at ingress.

## Revision 3 — one machine, and a namespace you own

Revision 2 was implemented faithfully and the defect it existed to remove **reappeared inside the owner
module**. Two tier-1 reviewers returned BLOCKING-only verdicts. The design was insufficient, not the
implementation, and parts of it were wrong rather than incomplete.

### What Revision 2 got wrong

**It named the wrong home.** Its governing sentence and three of its invariants guard
`openOrResetBackendStoreDb`, whose only callers are the recovery arm, the operator path and a type test.
Production startup enters through `coordinateActiveStoreSelection`, and `authorizeClassifiedStore`
narrows the publication union to an incident or `undefined` — so `leftActive` is discarded and the
still-incompatible database is opened anyway. The two-pass loop was dead code on the production path.

**Seven fields are not an identity.** `sameEvidenceIdentity` compares `dev`, `ino`, `mode`, `size`,
`mtimeNs` and both type predicates, and `openActiveEvidence` uses it — so ordinary WAL growth between
enumeration and descriptor open fails the check and refuses the boot, on the arm that exists _because_ a
writer is live. The same module already answers the same question correctly elsewhere:
`linkActiveEvidence` compares `dev` and `ino` alone. That inconsistency was the tell.

**`removeActiveEvidence` is the observe-then-act shape the redesign set out to eliminate**, written
inside the module created to eliminate it.

**"Claims throw" is not an extendable category.** It is defined by what the manifest asserts, so an
author reasoning backward from manifest to descriptor to enumerated identity lands a throw on a _source_
path. Nothing in it says which namespace a path lives in, and namespace is the only thing that decides
whether a surprise is a fault.

**The completeness check was carried forward without applying the design's own reasoning.** Rejecting
every active name absent from the manifest is inherited from `v0.10.9`; Revision 2 kept it while arguing
that classification judges what remains.

**The rollback claim held only for the link arm.** A shipped build meeting a torn copy hashes the present
active name against the manifest and refuses. Ordering fixes it, not a new mechanism.

**The behaviour sweep did not earn its billing.** It publishes directly and calls the dead opener, so it
never exercises the production route; and its replacement variant asserts only that boot succeeded, so a
run that deletes someone else's file counts as a pass. An invariant satisfiable while the defect is
present is a smoke test.

### The rule

> **The store directory is shared; the quarantine is owned.**
>
> A shared name is read, renamed into the quarantine, or linked back from it — never
> inspected-then-unlinked, never overwritten, never renamed over. After enumeration nothing observed at a
> shared name throws: an inode you did not enumerate is the next epoch, a size or mtime that moved is
> `torn`, `ENOENT` is `absent`, any other errno is `undeterminable`.
>
> An owned name is one you created. An entry you did not create, a post-condition that fails, or a
> syscall the filesystem refuses is a fault and throws.

**Read it, rename it, or link it back; inspect only what you own.**

Two categories replace three. "Claim" disappears because the manifest is written only once every name of
every inode it describes is owned. The single shared-directory refusal that remains is a _precondition_
stated once at the top of the sequence — enumeration refuses an entry that is not a regular file, before
anything has moved — so no author can generalize from it.

### Removal is a capability: park, inspect, drop or link back

Exclusive namespace ownership is unattainable against the only population that can race: every Coral
actor is already excluded from replacing an inode by the adoption lock, the reset lock and the
maintenance lease, and SQLite never renames over `store.db`. The racing party is foreign, and POSIX
offers no mandatory lock and no conditional unlink. So the answer is a primitive, not a lock.

You cannot inspect-then-act on a name you do not own. You _can_ move whatever is at that name into a name
you do own, and then inspect what arrived:

```
park(name):  rename(active/name -> <root>/.parked/<op>/name)     atomic; takes whatever is there
             ours?  (dev, ino) equals the enumerated identity
ours:        unlink(parked)                                      the only unlink, on an owned path
other:       link(parked -> active/name)                         atomic claim; EEXIST means a newer epoch owns it
             success -> unlink(parked); the name is `left` for the next pass
             EEXIST | EXDEV | EPERM -> keep parked, record in the ledger, `left`
```

Every step is on an owned path or is an atomic claim that fails rather than clobbers, and there is no
arm-specific branch: the link arm drops a parked inode its staged link already holds, the copy arm drops
the source it already copied, the discard arm parks and drops.

**Order matters for rollback.** Staging reads from the active name so the multi-second copy window leaves
that name intact. Parking precedes the manifest, so the crash state a shipped build can meet after the
manifest has an **absent** active name — which `v0.10.9` skips — and the present-active-torn-source state
it would refuse on can no longer exist.

`.parked/` is a sibling of `.staging/`, not inside it: shipped `detectInterruptedIncident` descends only
into `.staging`, and a sidecar there would make every shipped build refuse as `foreign`.

The exit for a kept-parked file exists: the ledger names it on its incident's retention record, `list`
renders it, and `release <incident-id>` removes `<root>/<id>/` and `<root>/.parked/<id>/` together.

### One machine

The machine lives where the reset lock is taken — the coordination module — as `settleActiveStore`,
returning an `ActiveStoreSettlement` carrying the opened database, the resumed incident, one publication
per settled epoch, and any invalid-target evidence. `openOrResetBackendStoreDb`,
`authorizeClassifiedStore`, `openProtocolStore`, `openPreparedStore`, `recordRecoveryOutcome` and
`recordInvalidTargetRecovery` are **deleted**. The last two exist only because the result type could not
carry a fact.

Routing production into the standalone opener is the other option and is worse: the `newer-incompatible`
transition policy is coordination vocabulary that would have to flow down as a side-effecting callback,
and the second door would remain.

No disposition can be dropped because there is exactly one call to
`publishClassifiedBackendStoreResetIncident` in `src/`, it sits inside the loop, and its result is pushed
and tested in the same block. The operator arm keeps its stricter lease and its unauthorized resume as a
`mode` the one machine takes.

### Consequences

Identity becomes exactly `{ dev, ino }`. `reobserve`, `ActiveEvidenceExpectation`, `hashActiveContent`
and `sameEvidenceIdentity` are deleted; a size or mtime that moved is `torn`, recorded through the
descriptor. The completeness check is deleted — a name outside the settled epoch is the next epoch.
Resume takes the `WriterExclusion` the machine holds and re-selects its primitive, so a linked staging
under unproven exclusion is re-staged as a copy rather than committing an artifact whose reader verdict is
permanently `mismatch`.

`releaseStoreResetIncident`'s post-`rmSync` sync failure is the same §11 family but a local fix: the
`released` variant carries whether durability was proven, instead of throwing after the bytes are gone.

### What the sweep must assert

It enters through `coordinateActiveStoreSelection` — by construction, once there is no other function
that publishes. Mutations are applied before the Nth active-path call: deleted, replaced (by a
_compatible_ store carrying a sentinel table, so a run can prove the replacement was classified rather
than merely surviving), appended (same inode, WAL growth), sidecar, and crash — crossed with the others
applied between crash and resume.

The assertion is a **conservation law**: every inode the fixture ever placed at an active name is
findable at the end by `(dev, ino)` at its active name, in a committed incident directory, or in
`.parked/`; or, for an enumerated original on the copy arm only, by content in a manifest entry. **An
injected inode may never satisfy the content clause** — that is the clause a run which deletes someone
else's file fails. Plus: `appended` yields a committed incident recorded `torn`; `replaced` makes the
sentinel readable through the opened database or present as a second incident; `pending` is null unless a
kept-parked file is named; `.staging/` is empty.

### Invariants

`ActiveEvidence.identity` has exactly the members `dev` and `ino`. In the owner, every storage call on a
candidate path is one of lstat, open-for-read, rename-from, or link-from/link-to, and `unlinkSync`/
`rmSync` receive only paths built from the parking root. In `src/`, `openOrResetBackendStoreDb` does not
exist — replacing the `quarantineStoreFiles` ghost guard, which names a symbol that never existed;
`publishClassifiedBackendStoreResetIncident` has exactly one call expression, enclosed by the loop; and
`openStoreDatabase` is called once in that module, after the loop.

## Revision 4 — publish once, then claim the name

Revision 3's settlement loop was capped at two publications, and a live foreign writer that wins the race
twice reaches `refuseIncompatibleBackendStore`. That is a boot refusal for a non-filesystem reason, in a
bound this document specified — the fourth instance of its own subject. The ruling is above: **the
sentence was the defect**, and the mechanism follows from the replacement.

**A fifth instance was sitting one line after the loop the whole time.** `openStoreDatabase`'s writable
arm is create-or-inspect on a shared name and throws `storeSchemaOutdatedError` on an incompatible
occupant (`src/store/db.ts`). So "boot anyway on the last pass" was never available: the open itself
refuses. The writable arm gets a decision union — opened, or the occupant's classification — and it has
exactly one caller, so the two read-only callers keep mapping to `store_schema_outdated` unchanged.

**And the invariant asserted the defect's presence.** `tests/invariants/store-reset-discipline.test.ts`
literally contains `expect(body).toContain('publications.length === 2')`. A guard that pins the bug is
worse than none.

### The machine

Three phases, in order, with `publishClassifiedBackendStoreResetIncident` called **at most once** and
enclosed by no loop.

**Mint the epoch.** Enumerate, classify, enumerate again. Identities equal → that is epoch 0, bound to
that classification. Unequal → the second enumeration is the epoch; classify it. This is the remedy for a
stale classification authorizing a reset of an inode it never saw: `publishIncident` no longer
re-enumerates, and `enumerateActiveEvidence` has one call site outside the owner.

**Claim the name**, only when the name is to be fresh. Mint a store on an owned path under the quarantine
root, then:

```
loop:
  park every present name of the four into .parked/<uuid>/    sidecar written durably first
                                                              rename ENOENT → absent; any other errno → throw
  if store.db was parked: classify it AT ITS PARKED PATH      owned; unreadable is a value, never a throw
      compatible | fresh → link that epoch's names back; open in place → adopted; return
      anything else      → record the classification in the sidecar; keep
  link(minted → dbFile)
      EEXIST → continue                                       the occupant is the next epoch
      other errno → throw                                     owned side, or a refused mutation
  open dbFile; identity equals the minted one → claimed, else adopted
  return
```

**There is no counter, and progress is structural rather than counted.** Every iteration either moves a
new inode off the name, finds the name free, or throws on a refused syscall. An adversary can cause
iterations only by producing new SQLite files; each costs it a whole store and costs Coral one `rename`
and one `link`. Nothing is ever inspected on the shared name — an occupant is classified only once it
sits on a path Coral owns, which is Revision 3's own maxim applied to the step it forgot.

**A refused mutation throws.** Revision 3 softened Revision 2's rule by mapping any non-`ENOENT` rename
errno to `undeterminable`; that clause was about _observations_ and was over-applied to a mutation. An
immovable occupant is then reported as what it is, and `store_reset_quarantine_failed`'s existing
"check permissions" text is finally the true cause instead of a second incident of the same bytes.

### Terminal disposition

`ActiveStoreSettlement` carries an ordered `epochs`, each `described` (at most one, the publication),
`parked` (with its parking id, a cause of `intruder` or `residual`, names, and any classification),
`adopted`, or `claimed`. The last element is always `claimed` or `adopted`. **There is no refusal
variant, and that absence is the invariant.**

### Deleted

The loop and its cap; `forcePreserve`; `residualEvidence` and the synthesized last classification —
residual siblings are parked by the claim loop with cause `residual`; the `writerExclusion === undefined`
throw, since exclusion is taken only when epoch 0 needs a reset and the claim loop publishes nothing;
`refuseIncompatibleBackendStore`, whose only live effect was `legacy-adoptable`, which the opener already
raises itself; and with it the three `store_*_incompatible` error codes, which nothing can throw once the
loop is gone. Clean-slate ownership says they do not linger as dead registry entries.

### Two homes for two roles

`pending` stays a singleton — exactly one publication is in flight under the reset lock, which is a
legitimate singleton — and indexes only that transaction, cleared unconditionally when it ends. **Every
terminal parking is a self-describing directory** carrying `parked.v1.json`, additive-only with a
tolerant reader, written durably before the first rename into it. Its existence is the obligation, which
is the same authority this document already grants incident directories. So `parkingId` and every
`parked` field come out of the ledger: the ledger is the slot's status, the directory is the bytes'
status, and a `latest`-shaped record cannot index per-item obligations without orphaning all but one.
None of it has shipped.

`release` gains a `parked` result kind — today such an id is misreported as `not-holder`.

### Invariants

Replacing the guard that pinned the defect: `publishClassifiedBackendStoreResetIncident` has exactly one
call expression in `src/`, enclosed by no loop; inside every loop body of the settlement function there
is no `throw`, no call to a `refuse*` or `documented*` constructor, no numeric literal of two or more, no
identifier matching a max/limit/budget/timeout shape, and no `.length` comparison against anything but
zero; and in the owner, a `linkSync` destination derived from `dbFile` has its source under the minted or
parked directories only.

The behavioural backstop is a **K-replacement adversary sweep** entering through
`coordinateActiveStoreSelection`: for each active-path call index and K in {1, 2, 3, 5}, land an
incompatible sentinel store K times, then assert the boot succeeded, the conservation law holds, the
parking root holds exactly K sentinel inodes each with a sidecar naming `intruder`, and `list` renders K
rows. The reviewer's finding is literally K = 3.

## Revision 5 — prove what you opened, and make the guard semantic

Revision 4 removed the cap and the fifth instance. A fourth review round found a **sixth**, and it is the
most instructive one yet: the parking helpers `rename` successfully and _then_ throw because the parked
object is not a regular file. **No syscall was refused.** The governing sentence already forbids this —
the rule did not fail, the implementation never consulted it.

### Why it keeps escaping: the guard has always been one level too shallow

Round 1's guard matched on **call text**, so `candidate.source` walked past it. Round 4's guard scans the
**lexical loop body**, so a throw inside a callee walks past it. Each guard was written against the shape
of the defect that had just been found, and the next defect simply sat one level further out.

**The guard must follow the call graph, not the block.** Within the settlement function's reachable
closure through the store modules, the only `throw` permitted is a rethrow of an errno the code did not
map — a refused syscall. Anything else is a disposition. That is checkable, it is what would have caught
the non-regular-file throw, and it does not need rewriting when the next call site moves.

### A successfully parked occupant is never a refusal

Enumeration may refuse a non-regular file _before anything has moved_ — that is a precondition, stated
once. After a successful `rename` the object is in owned space and nothing about it can refuse a boot: it
is parked, recorded in its sidecar with what it actually is, and left for `list` and `release`. The
occupant being a directory or a symlink is a fact about the intruder, not a fault of ours.

### The opened handle must prove which inode it opened

`openWritableStoreDatabase` opens the shared pathname, and everything after it assumes the handle
corresponds to `store.db`. A foreign replacement between the open and the identity observation makes that
false, and the code then deletes the minted or restored directory — the last link to the inode the handle
holds — and reports the result as claimed or adopted. Writes to that handle vanish when it closes.
`activeNameHasIdentity` compounds it by collapsing every non-`ENOENT` observation failure into `false`,
so an `EIO` reads as evidence of adoption.

**Retain the owned links until a post-open identity decision resolves**, and make that decision three
answers: same, different, undeterminable. `different` closes the handle and goes round the claim loop
again — it is the next epoch, which costs the adversary another whole store. `undeterminable` is a
genuine observation failure and propagates. Only `same` may drop the owned link, and only then may the
settlement call the epoch claimed or adopted.

The adversary sweep did not catch this because it asserts filesystem conservation and then merely closes
the returned database. It must additionally assert **which inode the returned handle opened**.

### One durable transaction, not three

Publication, discard and claim each write their own in-flight sidecar, and two of them start with
`incidentId: null`. Recovery selects only records with a non-null incident id, while pending detection
treats every in-flight sidecar as pending forever — so a crash after a `rename` into parking but before
the sidecar terminalizes leaves a full store that nothing reconciles, that `list` renders as holding no
files because it trusts `record.names`, and that `release` misreports as `not-holder`. Repeated crash
cuts accumulate whole stores without bound, which is the retention objective inverted.

Model the three as **resumable variants of one durable transaction**. The pre-rename record carries
enough names and identities to reconcile every rename that may have succeeded, discovery consumes every
in-flight variant rather than only publication's, and terminalizing parking happens **before** the only
identity record is cleared — today `recordStoreResetPreserved` clears `pending` first, so a crash in
between leaves resume with an empty expected set that rejects the real parked file, permanently.

### The operator surface must not hide what release will delete

A committed incident and a terminal parking directory may share an id, but committed rows hard-code an
empty parked list and the merge drops any parked row whose id is also an incident id. So `list` shows no
parked files while `release` deletes them. A parking-only row also tells the operator to run `report`,
which inspects only the committed incident directory and answers `not_found`. And a `.parked` root that
is not a directory, or escapes containment, is silently rendered as empty rather than as a refusal to
describe it.

`release` needs a partial-mutation arm: parking removal succeeding and incident removal failing is a
destructive operation that half happened, and it currently reaches the operator as a reporting error
whose remediation says not to delete evidence.

## Revision 6 — make the search exhaustive, not inspired

Round five found a seventh instance: on the **link** arm, a live writer appending to the linked inode
while it is hashed makes `describeCandidate` throw, and that becomes `store_reset_quarantine_failed`. No
syscall was refused. Interference during hashing is a `torn` disposition, exactly as it already is on the
copy arm.

### Why the guard and the sweep keep having a hole in the same place

Revision 5 asked for a guard that follows the call graph. The guard that was built computes a closure that
ends up scanning throws in one module. The sweep, meanwhile, **omits the `appended` mutation from the link
arm** — the single cell where the defect lives.

Three rounds running, the guard and the sweep have been written by the party writing the code, shaped by
the defect that had just been found, and the next reviewer has found the cell next to it. That is not a
discipline problem; it is a coverage problem, and coverage is mechanisable.

**The sweep becomes an exhaustive cross-product, generated rather than enumerated.** Every arm — link,
copy, discard, claim, resume — crossed with every mutation — deleted, replaced, appended, sidecar,
non-regular, crash — crossed with every recorded active-path call index, and crossed again with each
mutation applied between a crash and its resume. No hand-picked subsets, no arm-specific omissions. A cell
that is genuinely unreachable is skipped **by an assertion that it is unreachable**, not by absence from a
list. If the matrix is generated from the arms and mutations, a missing cell becomes impossible rather
than unlikely.

**The guard's closure is computed from imports**, not from a hand-maintained module list: every module
reachable from the settlement entry through `src/store/` is in scope, and the only `throw` permitted
anywhere in it is a rethrow of an unmapped errno.

### The remaining findings

**Live mutation during hashing is `torn` on both arms.** Only a link-unavailable error currently selects
the copy fallback; a mutation error escapes. Both arms already know how to record `torn`.

**`release` must gate on the parking record's phase.** An `in-flight` parking directory is a crash-recovery
transaction, and `list` currently collapses it to the same `parked` state as a terminal one while showing
its still-empty entries — so an operator following the advertised command deletes the only copy of an
epoch startup was about to resume. In-flight parking is described as such and is not releasable through
the ordinary path.

**The release union must cover partial effects inside a recursive delete.** Parking removal sits outside
the catch entirely; an incident-only failure reports `undeterminable`, whose renderer then asserts that no
evidence was released; and the final directory sync can throw after both trees are gone. Each is an
irreversible effect with no truthful disposition.

**An aborted pre-manifest publication must not brick the next boot.** When recovery keeps parked evidence
it cannot restore, it leaves the in-flight record; the next boot finds a sidecar with no staging entry,
assumes the incident committed, resolves a directory that never existed, and refuses with
`store_reset_interrupted_foreign` — persistently.

**Claim recovery must finish what the live path would have done.** Recovery terminalizes a parked epoch
without classifying, restoring, opening or identity-verifying it, so a compatible store parked just before
a crash is abandoned while a fresh one becomes active. The live compatible path has the mirror window: it
writes its terminal record before restoring and proving identity.

**`.minted` needs discovery and a bound.** Every claim mints a complete store in a fresh UUID directory
and cleans up only after post-open verification, so a crash between them leaves it forever with no
production path that reads `.minted` and no operator surface.

**Adoption must not delete non-regular siblings.** The compatible branch restores only regular files and
then recursively removes the whole parking directory, destroying a parked non-regular sibling instead of
retaining it as terminal evidence — and returns no parked epoch for it.

**The database handle must be closed on every failure after it opens.** Cleanup failures after the open
throw with the handle live, and the caller cannot close it because the assignment happens only on return.

## Revision 7 — a number instead of a hope

Round six produced an eighth instance and, more usefully, a measurement. The semantic-throw guard was
implemented as a snapshot: it accepts **142 semantic refusals** in the import-reachable closure and
freezes their count and digest. Updating the digest blesses any new one, and the guard passes while three
of the round's blocking findings remain reachable.

**142 is the honest distance between this code and its own rule**, and driving it to zero is a better
terminal condition than "the reviewers stopped finding things". Every round so far has ended when two
readers ran out of ideas; this one can end when a number reaches zero.

### Two findings are limits, not bugs, and their answers follow from the maxim

**A hard link cannot be made immutable.** The maintenance lease drains _registered_ writer leases; it
cannot prove that no uncooperative process holds a writable descriptor. So an append during the post-park
rehash raises a mutation error that becomes `store_reset_quarantine_failed`, and an append _after_ the
rehash leaves a committed manifest that no longer describes its own evidence — staging validation checks
entry names and count, not digests. The link arm's premise is therefore false in general. **Describing
linked evidence must be tolerant — `torn`, never a throw — and a manifest may only claim what a separate
inode guarantees.**

**A writable SQLite handle cannot prove its inode before opening.** `DatabaseSync` opens by path, and
`openWritableStoreDatabase` applies schema, pragmas and version metadata _before_ any identity check — so
a foreign actor who replaces `store.db` with a symlink to an external file between the link and the open
gets that file mutated by us, outside our owned namespace, with no undo. The answer is the maxim taken to
its conclusion: **open only owned paths.** Mint and open inside the owned directory, then `link` the
already-proven inode into place. The shared name is touched by `rename` and `link` and by nothing else —
not even by an open.

### The rest of round six

**The sidecar-before-first-rename rule is violated by the code that recovers minted stores**: it renames
`.minted/<id>` into `.parked/<id>` and syncs before writing `parked.v1.json`, so a crash in between
strands a complete store whose record is malformed, which recovery skips forever. The rule is already in
this document; apply it everywhere, and let an import-closure check assert that no rename into a parking
directory precedes its sidecar.

**`list` and `release` must agree about every parking state.** Discovery distinguishes `parked`,
`in-flight`, `malformed`, `unsafe` and `unavailable`, and the final merge then reduces a same-id row to
its entries and suppresses it entirely when a committed incident shares the id. Release, meanwhile,
collapses absent, malformed and unreadable sidecars to one value and blocks only a successfully parsed
in-flight record — so a malformed sidecar is deleted while reporting `not-holder` with proven durability.
Reproduced by a reviewer. **An unreadable record is not a terminal one**, and the operator surface must
show everything an irreversible release can remove, with incident and parking bytes reported separately.

**A second crash during pre-manifest recovery must not brick the next boot.** Recovery deletes the
staging directory before terminalizing the parking record, so a crash between them leaves an in-flight
sidecar that makes the next boot assume a commit, resolve a directory that never existed, and refuse
permanently. Terminalize the transaction durably **before** deleting its last witness.

**The in-flight transaction needs a fixed coordinate separate from terminal evidence.** The parking scan
bound is currently converted into `store_reset_interrupted_ambiguous` — the eighth instance — and the
change itself produces the state that reaches it, because every raced claim epoch and every interrupted
mint leaves a terminal parking directory that nothing reclaims. A bound on one scan is not a bound on
accumulated evidence. Give the singleton in-flight transaction its own address, reuse one minted
coordinate rather than minting UUID directories forever, and make the scan's truncation a disposition
rather than a refusal.

### The guard becomes the measure

Replace the snapshot with the count. The invariant asserts that the import-reachable closure from the
settlement entry contains **zero** semantic refusals — every `throw` is a rethrow of an unmapped errno —
and until that is true it asserts a ratchet: the number may only decrease. A digest that can be updated
proves nothing; a number that may only fall cannot be satisfied by blessing.

## Revision 8 — ancestry is not compatibility, and the sweep's blind dimensions are now named

Round seven brought the count from 142 to 137 and deleted the link arm — a hard link cannot make retained
evidence immutable against a descriptor nobody registered, so incident evidence is always copied onto a
separate inode. It also refuted one sentence of Revision 7 correctly: the shared name must be _observed_,
since the protocol has to `lstat` and identity-check it. The boundary is that shared-name **mutations**
are `rename` and `link` only, and a writable SQLite handle never receives a shared path.

### The worst finding in this document, and it came from its own specification

Revision 2 defined descent as: the live store descends from the holder's reset when its
`storedFingerprint` equals the holder's `expectedFingerprint` and its `storedProductVersion` is at least
the holder's `build.version`. **That establishes format compatibility, not causal ancestry.** A restored
backup, another namespace's database, or a foreign replacement carrying the same fingerprint is
classified a descendant and irreversibly discarded, while the holder contains none of its data.

The existing test constructs an independent database with its own sentinel table, labels it a provable
descendant, and then asserts the discard receipt rather than conservation of that database's contents.
**The test encodes the defect.**

**Fingerprint and version may no longer authorize a discard.** Without a durable causal-lineage token
proving ancestry, lineage is `undeterminable`, and `undeterminable` preserves over the bound — the path
that already exists. A discard is authorized only by evidence about _where the bytes came from_, never by
evidence about _what shape they have_.

### `legacy-adoptable` is silently replaced with an empty store

It is excluded from incident publication, but settlement still mints and enters the claim loop, and only
`compatible` and `fresh` can take the adoption path — so a legacy database is parked as terminal evidence
and an empty minted store is linked into its place. The established contract raises `store_schema_outdated`
rather than adopting implicitly. The unit test does not catch it because its helper mocks every writable
open, and the one invocation it makes throw is the _minted_ store, not the parked legacy one.

Handle the classification **before** mint and claim, and make the settlement total over the whole
`StoreFormatClassification` union rather than over the subset the reset path happens to care about.

### The fixed coordinate must be total over its own states

`.parked/.in-flight` is created before its sidecar and terminalized before its directory is removed, so
two ordinary crash windows leave it present with no record or with a terminal record. Recovery selects
only parsed `in-flight` records, so both are ignored; the next claim recreates the directory, gets
`EEXIST`, and every restart repeats it. `list` shows the literal id `.in-flight`, which `release` rejects
as noncanonical — a state with no operator exit.

Worse, publication's cleanup recursively deletes that fixed directory on a failure path it reaches
_before_ it ever owned it, so a pre-existing coordinate's bytes are erased by an invocation that neither
created nor validated it. **Recovery must be total over absent, malformed, unreadable, in-flight and
terminal, and cleanup may only remove what this invocation created.**

### `list` and `release` must agree about the whole directory

Both compute bytes over the four canonical evidence names while `release` recursively removes everything.
A file or subdirectory placed in an otherwise valid parking directory is invisible in the listing and in
the result accounting, and is irreversibly deleted. The operator surface must describe everything an
irreversible release can remove.

### The classification must be bound to the inode it classified

The classifier opens `store.db` by pathname without capturing the opened inode, so a foreign actor who
swaps in an incompatible store for the classifier's open and restores the original before the second
enumeration pairs that classification with the original's evidence — quarantining a live compatible store
and writing a manifest that describes bytes it does not hold.

### The sweep's missing dimensions, as the reviewers named them

Round seven's reviewers answered sweep-reachability for every finding, and nearly every answer was
"unreachable". Their enumeration is the specification for the next extension:

- **causal lineage** — a true descendant versus a schema-identical unrelated store — with an oracle that
  requires conservation of the discard arm's starting data;
- **crash cuts over internal durable-state transitions**, not only active-pathname operations: sidecar
  absent, malformed, unreadable, in-flight and terminal;
- the **complete `StoreFormatClassification` union** at both the initial and the parked classification
  points, `legacy-adoptable` included;
- a **pre-existing transaction coordinate** rather than a clean quarantine;
- **quarantine-directory content beyond the four canonical names**;
- an **operator-release arm**;
- **classifier-open identity observation**, and **multi-step ABA mutation** rather than one mutation per
  cell.

A sweep that traces only `runtime.storage` calls against the active pathname cannot see any of these. The
tracer has to cover the durable records too, and the matrix has to admit more than one mutation per cell.

## Revision 9 — the rule, stated by the owner

> **At the 1 GiB bound, rename and keep exactly one.**

That is the whole retention policy. The revisions above accumulated lineage inference, excess
accounting, causal tokens and preserve-over-the-bound paths on a premise the owner has now corrected
twice: **the store matters to nobody.** The operator touches it constantly and has no reason to keep it;
the user does not know it exists. The original position was an unconditional reset, and renaming one copy
aside was a concession to a recommendation, not a requirement.

So the ladder argument that rejected newest-wins eviction in Revision 2 rested on preserved evidence
being valuable. It is not. Newest wins.

**Delete, do not add:** lineage classification, the causal-token idea, `excess` and its counters, and the
undeterminable-preserves-over-the-bound path. A reset preserves its own evidence and removes the previous
preserved copy. Commit the new one durably first, so a crash can never leave zero.

No further retention rules are to be introduced.

## Revision 10 — authority is what the act takes, not what the act may call

Round 17's two reviewers returned eight blocking findings that are one sentence:

> **An operation that takes time continues to act on authority it may no longer hold, because the
> authority is carried as an optional callback beside the act instead of as the thing that permits it.**

Instances, all re-verified against the tree:

- **The reset lock throws away its own lease.** `acquireDirectoryLockSync` returns a `DirectoryLockLease`
  — a callable carrying `assertOwned()` and `maintain()` — and `acquireBackendStoreResetLock` assigns it
  to `let releaseDirectoryLock: () => void` (`backend-store-reset.ts:3025`). The composed `maintain`
  refreshes adoption and writer exclusion; the 30 s marker under `store.db.reset.lock` is never touched,
  and `assertOwned` answers from a local `owned` boolean (`:3041`–`:3053`). A reviewer aged the marker
  31 s, called `maintain()`, and a contender took the lock the lease still claimed to hold.
- **The claim loop passes a partial authority.** `resetLock?.maintain ?? adoption.maintain`
  (`active-store-selection-coordination.ts:498`) drops writer exclusion on exactly the path that skips
  the reset lock — the compatible fast path, whose hard-link clone is the longest copy in the system.
- **A lost lease reads as a clone failure.** `catch { return abandonClone(); }`
  (`backend-store-reset.ts:2340`) converts the `DirectoryLockOwnershipLostError` thrown by the per-chunk
  refresh into "the minted store is the safe candidate", and the caller then terminalizes the occupant
  and installs the mint (`:2791`).
- **The verification pass re-reads the file with no authority at all.**
  `copyActiveEvidenceForPublication` refreshes per chunk; the `evidenceMatches` → `describeCandidate`
  hash that follows takes the `() => undefined` default (`:477`, `:590`, `:673`, `:918`). Every refreshed
  copy is followed by an equally long unrefreshed read — in publication, claim cloning and restaging alike.

The defect is not four missing calls. It is that `maintain` is a parameter with a default, so
**forgetting it is well-typed**, and every round the guard has sat one level shallower than the omission.

### The act takes the authority

One value: threaded, required, branded.

`settleActiveStore` composes a single `SettlementAuthority` over adoption, proven writer exclusion, and —
when taken — the reset lock's own `DirectoryLockLease`. It has one method, `hold(): Held`, which
refreshes **every** layer it holds and re-proves each from its marker, throwing if any is gone. There is
no separate `maintain` and `assertOwned`: those two have already been allowed to disagree, one reading a
boolean and the other reading markers, and two answers to one question is this document's oldest finding.

`Held` is a brand with no exported constructor. Every function that mutates a shared name — the rename
into parking, the link back, the unlink, the commit rename — and every function that reads or writes a
whole file takes a `Held`. Not optional, no default. An act on stale authority then has nothing to pass,
and the four omissions above stop compiling rather than stop being noticed.

What follows mechanically: `resetLock?.maintain ?? adoption.maintain` has nothing to select between and
goes; `describeCandidate`'s callback parameter becomes a required `Held`, so the verification hash is
covered; and the clone's `catch` must let whatever `hold()` throws escape, narrowing to the I/O failures
it was written for.

### Classification at the active name is routing; only an owned inode authorizes an act

Round 17 answered "classify under exclusion without taking the reset lock" by copying every evidence file
into a private snapshot before classifying (`stageBackendStoreClassification`, `:769`). That copy now runs
on **every boot with an observed store, including the ordinary compatible one** — on the 1.17 GB store
that opens this document, a full copy per start. Neither reviewer priced it. It is the same mistake this
branch exists to remove, a cost that scales with the store placed on the boot path, differing only in
that it ends in slowness rather than a refusal.

It also does not buy what it was built for. A cooperating writer is already excluded; an adversary who
ignores the exclusion can replace the file the instant after the snapshot is taken, so the copy moves the
window rather than closing it. What closes it is already in the tree, and is Revision 4's sentence:
**classify a parked occupant at its parked path, never at the shared name.**

So:

- `stageBackendStoreClassification` is deleted. Classification before the claim happens in place on the
  active pathname and is **advisory**: it selects which branch runs and authorizes nothing. The type says
  so — it cannot be passed to anything that acts.
- Every branch that acts re-derives its classification from an inode it owns. Both already do: the claim
  path from the parked copy (`:2701`–`:2711`), the writable open from the descriptor it holds.
- `legacy-adoptable` therefore has exactly one refusal site — the parked one, after
  `restoreLegacyParkedStore` puts the inode back (`:2716`–`:2742`). The two early returns in
  `active-store-selection-coordination.ts` (`:432`, `:453`) go. They refuse the boot naming a
  classification taken from a copy, so a foreign process that replaces the legacy store with a
  current-format one during that copy leaves the coordinator refusing to start over an inode that is no
  longer there. That is a stale observation authorizing a refusal, which is this document's subject;
  whether `legacy-adoptable` should refuse **at all** remains the migration entry's question, not this
  one's.

### Retention: "exactly one" is a result, not a hope

Two sites drop it:

- `retainOnlyStoreResetPreservedCopy` skips a prior survivor coordinate whose path is no longer a
  contained directory — `if (error instanceof UnsafeStoreResetPath) continue;` (`reset-retention.ts:711`)
  — and then returns `true` (`:730`). Replace a committed survivor's canonical directory with a symlink
  or a regular file before each rotation and K replacements leave K coordinates beside the survivor. A
  reviewer reproduced it: `{ok: true, oldCoordinateRemains: true, newSurvivorRemains: true}`. The
  quarantine is owned, so a non-directory at a canonical coordinate is removed as the non-directory it is
  — `unlink`, not `rmSync` — and the external target is never followed.
- `recordStoreResetPreserved` flattens the rotation's `false` to `void` (`:809`–`:819`) while its sibling
  `recordStoreResetParked` returns it (`:733`). Publication then reports `preserved` with two copies on
  disk.

Rotation returns a disposition and the caller consumes it. The failing answer is **not** a refusal — that
is the defect this branch removes — but an honest outcome naming the copy that is still there, rendered
as such by the CLI and carried in durable status.

### Say what was established, not what was hoped

`release` renders unverified parking as terminal: "Released **terminal** store-reset parking … without a
verified sidecar" (`formatStoreResetRelease` in `src/cli/format/store-reset.ts`). The sidecar is
precisely what establishes the phase, and it was unreadable. The operator's authority to delete parking
they cannot verify is not authority to be told it was terminal. Three sites, so fix the class: the phase
word derives from the result kind, and a kind carrying `unverified` cannot render one.

### The guard

Every previous round's structural guard sat one level shallower than its defect — call text, then lexical
loop body, then single module. The guard that cannot be one level off is the type itself: `Held` has one
constructor, it is not exported, and every shared-name mutation and whole-file read takes it. The
invariant then has only to assert that — one constructor, unexported, no parameter of that type carrying
a default — which is shallow enough that there is no level beneath it to miss.

## Revision 11 — the guard must be derived, never enumerated

Revision 10 said the type was the guard and that "there is no level beneath it to miss." Both round 18
reviewers found the level beneath it independently, and they found the same one.

`dropParkedEvidence` unlinks a shared parking name and takes no authority at all
(`src/store/reset-active-evidence.ts`). `restoreParkedEvidence` holds before its `linkSync` and then
unlinks without re-holding (`:367`, `:376`). The invariant passed anyway, because what it checks is a
**hand-written list of twenty-nine function names** (`tests/invariants/store-reset-discipline.test.ts`)
— and `dropParkedEvidence` is not on it.

Reachable, and both reviewers reached it the same way: process A decides a parked entry is its own and
stalls past the stale interval; process B takes the locks, settles A's transaction, and reuses the fixed
`.in-flight` coordinate for new evidence; A resumes and unlinks B's store from a decision it made before
B existed.

So the count is four, and they are all one sentence:

| round | the guard                | the level it missed          |
| ----- | ------------------------ | ---------------------------- |
| 5     | call text in a module    | the lexical loop body        |
| 6     | the lexical loop body    | a second module              |
| 7     | a single module          | the import-reachable closure |
| 18    | a list of function names | the function nobody listed   |

> **A guard that enumerates its subjects fails at exactly the subject nobody enumerated. Derive the set
> from the tree — imports, types, call edges — or do not claim a guard.**

The one guard on this branch that has never failed is the semantic-refusal ratchet, and it is the one
that computes its closure from imports instead of naming modules. That is not a coincidence.

### Possession is not proof

The second half of the same defect, and it is a flaw in Revision 10 itself rather than in its
implementation. `Held` is a callable value that can be stored, passed on, and invoked whenever — so a
parameter of type `Held` proves that a function _could_ re-prove authority, never that it _did_, and
never that it did **immediately before the syscall**. `commitTerminalParking` holds, runs an arbitrary
caller-supplied `populate()`, and then renames the fixed coordinate (`backend-store-reset.ts:1794`,
`:1800`). Nothing about that is ill-typed under Revision 10.

Both halves have one fix. **The authority owns the syscalls.**

```
held.unlink(path)        held.rename(from, to)      held.link(from, to)
held.readWholeFile(path) held.writeWholeFile(path, bytes)
```

Each method re-proves every layer and then performs the call, with nothing between the proof and the
syscall. There is no `held` to forget, because there is no form of the act that does not go through it:
a caller holding a stale `Held` cannot mutate a shared name, it can only fail.

And the invariant stops being a list. It becomes one derived check over the import-reachable settlement
closure: **no module in that closure names a mutating or whole-file `StoragePort` member directly** —
`unlinkSync`, `renameSync`, `linkSync`, `rmSync`, `writeFileSync`, `readFileSync` and their kin reach the
filesystem only through the authority. That set comes from the port's own type and the closure from the
imports, so neither is written down by hand, and there is no list to be absent from.

Observation stays free: `lstatSync`, `existsSync` and their kin mutate nothing, and Revision 3 already
settled that observing a shared name is unavoidable.

### A refusal that cannot re-prove its evidence parks instead

The one remaining `legacy-adoptable` refusal is reached after restoring the parked inode, but it cites
the classification taken _before_ restoration (`backend-store-reset.ts:2849`, `:2884`). A reviewer
reproduced the gap with a writable descriptor opened before parking: the foreign descriptor changed the
same inode immediately after the parked classifier closed it, Coral restored the changed bytes, and then
refused the boot with `store_schema_outdated` naming a classification that no longer described anything.

This is not the accepted rename-while-open limit re-reported. That limit says the bytes may be corrupted;
this says an obsolete classification converts that into the exact boot refusal the branch exists to
remove. Under the governing rule a classification that cannot be re-proved **names neither a refused
syscall nor unknown evidence that proceeding would finalize, so it selects the next mechanism down**:
re-classify the restored file at the moment of the refusal, and if that disagrees with the classification
that routed here — or cannot be performed — park and claim rather than refuse. Whether `legacy-adoptable`
should refuse at all remains the migration entry's question.

### The incomplete rotation must reach the boundary that reports

`commitTerminalParking` computes and returns `incomplete` (`backend-store-reset.ts:1812`), and
`attemptBackendStoreClaim` drops the result on both terminalization branches (`:2929`). The `parked`
epoch carries no rotation field (`:244`), so the CLI can render an incomplete rotation for a `described`
incident and never for terminal parking (`cli/commands/backend.ts`). Startup then finishes
successfully with two retained coordinates and says only "Parked …", with the honest disposition alive
solely in an audit event that scrolls away — §11's "a refusal is visible as durable status, not only as a
log line", and `decision-union-results.md` besides. The rotation reaches the epoch, and the CLI renders
it for both survivor kinds.

### The size bound is instance sixteen

`enumerateActiveEvidence` throws `Store-reset evidence cannot be represented safely.` for a regular file
larger than `Number.MAX_SAFE_INTEGER` (`reset-active-evidence.ts:120`), on the startup path, before
anything can park. Nine petabytes is not reachable in practice and that is beside the point: **twelve
lines above, the same module answers the same question by returning `sizeBytes: null`** (`:107`). One
module, one question, two answers, and the throwing one is on the boot path — which is this document's
oldest finding and its whole subject at once.

Parking does not need a representable size; only reporting does, and reporting is what the original
1 GiB bound existed for. `sizeBytes` is absent when it cannot be represented, every consumer treats
absence as "not reported", and nothing on the reset path throws over it.

## Revision 12 — remove the freedom, and stop refusing a store this build can read

Round 19's reviewers agreed on three blocking findings and one of them found a fourth. Three of the four
are the same defect the previous revision was written to remove, arriving one layer down.

### The guard failed a fifth time, and adding a third derived axis will not stop a sixth

| round | the guard                                      | the level it missed            |
| ----- | ---------------------------------------------- | ------------------------------ |
| 5     | call text in a module                          | the lexical loop body          |
| 6     | the lexical loop body                          | a second module                |
| 7     | a single module                                | the import-reachable closure   |
| 18    | a list of function names                       | the function nobody listed     |
| 19    | a derived closure **and** a derived member set | what the supplied proof proves |

Revision 11's invariant genuinely derives both of its sets and is still blind, because
`createStorageActuator(storage, prove)` takes **any** callback. Fourteen construction sites exist; four in
`active-store-selection.ts` pass `() => undefined` while mutating shared coordination state
(`:580`, `:639`, `:683`, `:824`), and three in `reset-retention.ts` are `held ?? createStorageActuator(storage, () => undefined)`
(`:402`, `:523`, `:685`) — optional authority with a defaulted no-op, which is precisely the shape
Revision 10 abolished and Revision 11 was meant to make unconstructible. Both reviewers reproduced the
consequence: coordinator A's adoption lease goes stale, B claims it and publishes, and A's authority-free
durable write overwrites B's record with an adjacent "proof" that proves nothing.

Each round the guard checked one more syntactic surface and the defect moved to that surface's blind
side. So the answer is not a third axis.

> **Do not police a degree of freedom. Remove it.**

`createStorageActuator` stops being exported. An actuator is obtainable only _from_ a lease —
`SettlementAuthority.actuator`, `DirectoryLockLease.actuator` — so there is no construction site to audit
and no callback to supply: possessing an actuator _is_ the provenance. The one genuine pre-authority act,
creating the directory a lock will live in, becomes a single named function that does that one `mkdir`
and nothing else, and whose name says it is the exception.

And **reads leave the actuator entirely.** A read finalizes nothing, which §11 has said all along and
Revision 11 contradicted by protecting `readFileSync`; that contradiction is exactly what forced the
`held ?? no-op` reader shape into `reset-retention.ts`. Readers take the raw port, the optional-authority
parameter disappears with them, and a stale read is handled where it was always handled — by the act it
feeds, which is gated.

The invariant that remains is small because the structure carries the weight: no module in the derived
settlement closure names a protected **mutating** port member, and `createStorageActuator` has exactly one
call site, inside the lease that returns it.

### `legacy-adoptable` is adopted, not refused

**I ruled this out of scope twice and I was wrong.** Both rounds of trying to make the refusal sound
produced the same unclosable window — a reviewer showed that `classifyStoreFile` closes its handle before
returning, so no amount of moving the re-proof closer to the `throw` removes the gap — and that is the
signal that the refusal, not its placement, is the defect. The classification itself says so:
`legacy-adoptable` means **the stored fingerprint equals the current fingerprint** and only the
`store_product_version` metadata row is absent (`src/store/db.ts`). The schema is identical.
This build can read and write that store. It refuses to start on it, with an error code that says
`store_schema_outdated` about a schema that is not outdated.

That is the purest instance of this document's subject so far: a missing metadata row promoted into a
boot refusal on a store the running build can use. It is not a migration-policy question, because no
migration is involved — nothing needs to change but two rows that `applyBundledStoreSchema` already
writes with `INSERT OR IGNORE`.

So: adopt it. Stamp the metadata and continue. Delete `refuseLegacyStore`, `restoreLegacyParkedStore`,
`restoredLegacyClassificationStillApplies`, `refuseRestoredLegacyStore`, the re-proof and its descent, and
`store_schema_outdated`'s producer on this path. The stale-inode worry does not survive the change either,
because adoption re-proves itself where it acts: the insert runs in a transaction on the database already
open, and `applyBundledStoreSchema` refuses to write over a different fingerprint. If that refusal fires,
the store is not what was classified, and the answer is the next mechanism down — park and claim — not an
escaping throw.

### Rotation must never leave zero

`retainOnlyStoreResetPreservedCopy` proves the chosen survivor exists once, before syncing its parent
(`reset-retention.ts:733`), then skips that coordinate **by name** (`:761`), removes every other canonical
coordinate (`:784`), and returns `complete` (`:804`). A reviewer removed the new survivor during that
sync and got `rotation = complete(N)` with neither `N` nor the previous holder on disk.

"Keep exactly one" is a statement about the end state, so it is proved at the end, not assumed from the
beginning. Re-prove the survivor's **identity** — not its name — immediately before each superseded
removal; if it is absent or changed, remove nothing further and return `incomplete`. Newest-wins is
preserved and the failure mode becomes two copies, which is honest, instead of zero, which is the one
outcome the owner's rule forbids in both directions.

### The incomplete disposition needs a durable home

The rotation union carries `complete | incomplete` correctly and the discard command renders both
(`cli/commands/backend.ts`), but nothing stores it: the parked sidecar has no field
(`reset-retention.ts:61`), the ledger has only `pending` and `preserved` (`:131`), terminal parking writes
an audit event and returns (`backend-store-reset.ts:1801`), the list contract cannot express it
(`reset-incident-reader.ts:78`), and startup discards `result.epochs` (`startup-store-routing.ts:28`).
After a restart, `store-reset list` shows several coordinates and no reason. §11 asks for durable status
keyed by the identity it can be acted on with, not a line that scrolls away.

One canonical home: an additive field on the retention ledger, carrying the disposition, its cause, and
the survivor it failed to isolate — cleared when a later rotation converges, surfaced by `list`. Additive
and tolerantly read, per §10.

## Revision 13 — revoke the resource; stop enumerating the acts

Round 20's reviewers agreed on two blocking findings, found two more separately, and the guard failed for
the sixth consecutive round.

| round | the guard                                            | the carrier it missed                  |
| ----- | ---------------------------------------------------- | -------------------------------------- |
| 5     | call text in a module                                | the lexical loop body                  |
| 6     | the lexical loop body                                | a second module                        |
| 7     | a single module                                      | the import-reachable closure           |
| 18    | a list of function names                             | the function nobody listed             |
| 19    | a derived closure **and** a derived member set       | what the supplied proof proved         |
| 20    | an unexported constructor and a lease-owned actuator | **SQL, which is not a syscall at all** |

`openWritableStoreDatabase` in `src/store/db.ts` proves authority once through `held.makeDirectory`,
then opens a `DatabaseSync` and commits DDL and metadata rows with no further check; the next actuator
call notices the lost lease long after the transaction committed. Both reviewers reproduced it. The guard
cannot see it because it derives protected names from `StorageMutationPort`, and `DatabaseSync.exec`,
statement `run`, `openSync` and `openSqliteDatabaseSync` are all outside that vocabulary. A reviewer also
escaped the authority by reflection — `Object.getOwnPropertyDescriptor(authority.actuator, 'unlink').value`
returns the raw lease-scoped function, because a `get`-only Proxy is not a membrane.

Six rounds is enough to name the mistake in the method rather than in each guard:

> **Proving that every act is authorized requires enumerating acts, and acts are unbounded in kind. Make
> the act impossible instead: authority gates the resource, not the call.**

An `unlink` needs a path. A `COMMIT` needs a database handle. A carrier nobody has thought of still needs
the thing it operates on. So the authority's job is to own what its work runs on and to take it away the
moment it is no longer the owner.

### The authority revokes

`hold()` failing once kills the authority permanently. Every actuator it minted throws from then on, and
**every database handle it opened is closed**. A lost lease therefore does not merely fail the next
checked call — it removes the handle the unchecked carrier would have used, and `db.exec` fails because
the connection is gone. SQL never has to be modeled.

Two consequences to get right rather than discover later. Releasing leases must still work after
revocation: giving up ownership is not an act on contested state, and `finally` blocks must not throw.
And the settled database is **transferred out** of the authority's ownership at the moment settlement
decides to return it — transfer requires a successful `hold()`, and after it the handle is no longer
revocable, which is what lets settlement release its leases and hand back a live store.

The membrane stops being a Proxy. An explicitly constructed object whose methods close over the weaker
actuator has no reflective surface to walk, so `getOwnPropertyDescriptor` and inherited methods have
nothing to hand back.

And the invariant stops enumerating. It asserts one behaviour — **after a failed `hold()`, every actuator
operation and every minted handle throws** — which has no surface to be one level off from. What remains
of the AST check is structural and small: the constructor is unexported, and no Proxy stands between a
caller and a capability.

### Retirement must be recoverable, or rotation can still reach zero

Rotation re-proves the survivor's identity before each superseded removal, and both reviewers still drove
it to zero copies: the survivor can vanish between the proof and the `remove`, or during the final parent
sync, after which it returns `complete` with nothing on disk. A final re-proof stops the false `complete`
and cannot restore what was already deleted.

So the deletion stops being irreversible. A superseded coordinate is **renamed aside within the owned
quarantine**, the survivor is re-proved, and only then is the retired copy removed; a failed re-proof
renames it back. At every instant at least one copy exists under a name this build can find, which is
what "keep exactly one" has to mean when the adversary is concurrent — and it is the park-and-claim
ladder this document already uses, applied to retention.

### A database error is not a filesystem failure

`openCompatibleParkedStore` catches only `StoreFormatChangedDuringAdoptionError` and rethrows everything
else (`backend-store-reset.ts:2668`, `:2682`). A reviewer verified against Node's SQLite that a live
writer overwriting the parked inode's header yields `ERR_SQLITE_ERROR: file is not a database`, and an
exclusive transaction yields `database is locked`; either escapes settlement and stops the boot. That is
Revision 12's own adoption path producing the defect this document is about, one round after it was
written.

Any error from the writable re-open descends: terminalize the parking and claim afresh. Nothing about a
database's contents or its locks is a refused syscall.

### One home for the disposition, and a disposition that can be cleared

`formatStoreResetDiscard` in `src/cli/commands/backend.ts` says an incomplete rotation's survivor "remains on disk" for a
disposition that explicitly covers a survivor that disappeared, while a second formatter already words it
truthfully through the then-current `incompleteRotationStatus` formatter. Two homes for one sentence, drifting, which is §7 exactly:
delete the local wording and call the formatter.

And an incomplete rotation naming a survivor that no longer exists is retried forever and cannot be
cleared — releasing the absent id returns `absent` before reaching the code that would clear it.
Reconciliation derives its status from the coordinates that actually exist: exactly one remaining updates
the holder and clears the rotation; several remaining keep a disposition keyed to coordinates an operator
can act on.

### A lease may not advertise a capability its dependencies cannot back

`createDirectoryLockLease` in `src/infra/fs-lock.ts` casts a partial `DirectoryLockDeps.storage` — eight methods — to a full
`StoragePort` to build the actuator it advertises, so
`lease.actuator.syncDirectory(...)` throws for any conforming minimal dependency object, after proving
ownership. Settlement happens to pass a full runtime storage, so nothing fails today and the exported
contract is still false. Widen the dependency to what the actuator needs, or do not put an actuator on a
lease that cannot back one.

## Revision 14 — a live store's name is write-once

Seven guards failed in seven rounds, and round 21's failure was not an implementation gap: revocation is
lazy because the lease is lost when the _other_ process takes it and we learn at our _next_ check.
Tightening a check cannot close a window whose existence is the check's premise. So the design question
went to a pioneer, and it found the premise that all thirteen revisions inherited without examining.

> **The store lives at `<dbDir>/store.db`.**

Every "shared name" in this document is one of the four flat names `resolveBackendStoreFileSet` hardcodes
(`backend-store-reset.ts:311`-`:334`). Every reset must **vacate** that name and **reclaim** it. The
vacate is the one act that is harmful when stale — it removes the winning process's live store from under
it — and every lease, hold, revocation and membrane in Revisions 10 through 13 exists to serialize that
single act.

My own candidate was half right for the wrong reason. Conserving _inodes_ does not make a stale act
harmless: `rename(store.db → parked)` conserves the inode and is the most harmful stale act in the tree.
What must be conserved is the **live name**.

> **A live store's name is write-once. A reset is the next epoch, published beside the current one;
> nothing ever vacates a name a process may be live on.**

`<dbDir>/epoch-<N>/store.db` and siblings, plus a write-once `epoch.json`. The flat `<dbDir>/store.db`
every shipped build uses **is epoch 0, spelled the old way, and is never renamed**. The current epoch is
the highest `epoch-<N>` present, else 0.

```
settle(dbDir):
  loop:
    e = currentEpoch(dbDir)
    d = openWritableStoreDatabase(epochPath(e))
    if d.kind === 'opened': sweep(dbDir, e); return d.db
    m = `${dbDir}/.mint-${uuid}`
    openWritableStoreDatabase(`${m}/store.db`).db.close()   # a throw here IS a filesystem failure
    writeDurable(`${m}/epoch.json`, { supersedes: e, classification, build, publishedAt })
    try rename(m, `${dbDir}/epoch-${e+1}`)                  # atomic; the kernel decides who won
    catch ENOTEMPTY | EEXIST: rmrf(m); continue             # someone published e+1 — adopt it
    catch ENOENT:             continue                      # our mint was swept — re-mint
```

The loop has no counter and no refusal variant: each pass publishes, or observes a strictly higher epoch,
which is someone else's progress. `rename(dir → non-empty dir)` fails `ENOTEMPTY` atomically with both
sides intact — measured on this machine, ext4, Node 26.3.1.

### What it deletes

- **`settlement-authority.ts` entirely**, with `WriterExclusion`, the reset lock and
  `store_reset_lock_contended`, the actuator's role in settlement, and `hold()`'s forty call sites. The
  adoption lock stays exactly where it is (`active-store-selection-coordination.ts:714`) and becomes what
  this document kept trying to make the lease: **a performance mechanism whose loss corrupts nothing.**
- **`reset-retention.ts` entirely.** "Keep exactly one, newest wins" is the ordering of integers:
  `epoch-K` is garbage iff `K ≤ current − 2`. The sweep never names `current` or `current − 1`, so it
  cannot reach zero — the outcome two reviewers reached twice through the 200-line guarded-rename dance.
  K adversarial replacements land at `epoch-(e+1…e+K)`; the next boot publishes `e+K+1` and sweeps the
  rest. One copy, newest by number.
- **The copy, the two hashes and the manifest.** The preserved copy _is_ the superseded epoch, in place.
  On the 1.17 GB store that opens this document, `publishIncident` reads and hashes it, writes it, then
  re-reads and re-hashes to verify (`:1558`, `:654`, `:710`) — the record's own 3.99 s/GB puts that near
  twelve seconds against a fifteen-second incumbent deadline. **That is the original bug wearing latency
  instead of a refusal**, and Revision 10 deleted its twin while leaving this one standing.
  `storedProductVersion` is read by classifying `epoch-<e−1>/store.db` read-only, which is what the
  preserved copy being on disk at a readable path buys.
- **Every resume mechanism**: `.staging`, `.parked/.in-flight`, `.minted/current`, `pending`, and the six
  `store_reset_interrupted_*` refusals. An epoch is complete by construction — one directory rename — and
  a mint is garbage by construction. There is nothing to resume.
- **The accepted limit.** "Renaming a database another process holds open is undefined behaviour" stops
  being accepted because nothing renames an open database. A rolled-back build finds its own `store.db`
  untouched, classifies it compatible, and boots on its own data.

### The fixed coordinates were the authority's only subject

Sorting `hold()`'s call sites by what they touch gives three kinds: this epoch's own uuid coordinate,
where a stale write harms nobody; a **fixed** coordinate reused by every epoch — the four flat names,
`.parked/.in-flight`, `.minted/current`, the ledger — where two epochs collide; and destruction of
evidence, where the hold proves lock ownership, which is not the authority the act needs.

Both round-20 and round-21 carriers land on the second kind. `openWritableStoreDatabase` opens the fixed
`.minted/current/store.db` (`db.ts:357`), so a stale epoch's DDL lands in whichever epoch's mint holds
that name; the raw-descriptor write goes into `.parked/.in-flight/<name>.restage`
(`backend-store-reset.ts:1073`). Neither carrier can reach a uuid coordinate belonging to another epoch.
Remove the fixed coordinates and the authority has no subject: mints are `.mint-<uuid>`, epochs are
published by one rename, and `openWritableStoreDatabase` loses both `held` and `owner`.

Revision 13's sentence was one step short. Authority gates the resource — and the resource that needed
gating was the **name**. A name nobody reuses needs no gate.

The invariant shrinks to two static facts with nothing beneath them to miss: the only `rename` whose
destination matches `epoch-<N>` has a `.mint-` source, and the only deletion of an `epoch-` path is
inside `sweep`, whose predicate is a pure function of two integers.

### §11, finally placed

There are exactly three sites. `openWritableStoreDatabase(epochPath(e))` answers
`opened | incompatible | threw`, and `threw` — locked, not-a-database, `EIO` — selects the same mechanism
as `incompatible`, because minting finalizes nothing. That is what lets classification be imperfect, and
it retires `classifyBackendStoreFailure`'s `store_open_unclassified` refusal
(`backend-store-reset.ts:3152`). A genuine filesystem failure is then the **mint's own** open throwing on
a fresh private path — the one refusal the governing rule allows, and it cannot loop. The sweep's
authority to delete `epoch-K` is an observed `epoch-<K+2 or higher>`; a failed `readdir` is "max
unknown", which skips the sweep and boots. And `release <K>` refuses when `K === current` — a refusal
correctly placed on an operator path.

### Stated rather than hidden

"Newest" is by epoch number, not mtime. The one case where they disagree is upgrade → rollback →
upgrade: the old build wrote epoch 0 after epoch 1 was published, so epoch 0 is newer in time and older
by number, and is swept when epoch 2 lands. Under the owner's rule that is acceptable.

Two uncertainties remain. `rename(dir → non-empty dir)` is documented `ENOTEMPTY` on APFS but has been
measured only on ext4 here; Windows is unsupported. And a new CLI with an old live coordinator resolves
`epoch-max` while the coordinator serves epoch 0 — divergence, not corruption, until that coordinator
restarts, and only after upgrade → rollback → upgrade.

### One thing this uncovered that is not part of it

`retainTransitionFileInStoreResetQuarantine` writes active-store-selection audit copies into the
quarantine root, under a 1 GiB bound, and a failure becomes `store_reset_quarantine_failed` thrown on the
boot path (`active-store-selection-coordination.ts:323`). That is this document's subject, still standing,
in a module it never examined. It is rehomed to the coordination root rather than deleted, and it is not
optional.

## Revision 15 — a name is not an epoch, and no proof is not a licence to delete

Round 22's reviewers confirmed the core of Revision 14: the atomic publish is sound, `ENOTEMPTY` reconciles
two publishers, and nothing renames a database another process holds open. They then found four blocking
failures, all in the two places where the new design still trusts something it has not established.

### Discovery trusts a filename

`resolveCurrentStoreEpoch` selects by basename alone — no entry kind, no containment, no `epoch.json`, no
database (`epochNumber` and `resolveCurrentStoreEpoch` in `src/store/epoch.ts`) — and the selected name is
composed straight into a writable
SQLite path (`:66`, `:328`). Three reproductions followed:

- A regular file named `epoch-1` beside a valid flat store: startup selects it, gets `ENOTDIR`, publishes
  epoch 2, and **deletes the real epoch-0 store** because `current >= 2`.
- `epoch-1` as a symlink to `.`: SQLite follows the parent symlink and writes through `epoch-1/store.db`
  into the flat epoch-0 database. A reviewer reproduced exactly that.
- An empty `epoch-2/`: startup mints a fresh database inside the uncommitted directory and then sweeps
  the valid epoch 0.

> **A published epoch is proven, never named.**

A directory entry is an epoch only if `lstat` says it is a directory and not a symlink, it is contained in
`<dbDir>`, it holds `store.db`, and it holds an `epoch.json` that reads as valid under the tolerant
schema. Anything else named `epoch-<N>` is not an epoch: it does not authorize an open, it does not count
toward `current`, and it is garbage — it can only be a crashed mint or junk. Epoch 0 is proven by the flat
`store.db` existing as a regular file.

This also disposes of the numeric hazard both reviewers found. `epoch-9007199254740991` is accepted today,
its successor is not representable, so the loop publishes a directory discovery then ignores and contends
against forever — **a hang rather than a refusal, which is worse than the defect this branch removes.** A
number without a representable successor is not an epoch number.

### Deletion has no evidence behind it

The sweep predicate proves `K ≤ current − 2`, which is a statement about numbers and says nothing about
whether a process is live on `K`. Three reproductions:

- Every `.mint-*` is removed recursively (`:217`), including another publisher's mint with its database
  open. The displaced publisher then fails on a path someone else deleted — not a filesystem failure.
- At `current >= 2` the four flat names are unlinked (`:227`) while a rolled-back `v0.10.9` coordinator
  may be live on them. **That is the accepted limit returning in a worse form**: Revision 14 claimed
  nothing renames an open database, and instead this deletes one.
- `release <K>` reads `current` once, then deletes with no re-read and no ownership assertion
  (`operator-store-reset.ts:155`-`:164`). A stalled `release 2` resumes after epoch 2 has been published
  and removes the **current** database, printing durable success.

> **Deletion is a finalization, so it requires decisive evidence, and "no process is live on this" is the
> evidence it requires.** §11 has said this all along; the sweep read it as a retention rule instead.

Which makes the dispositions concrete. The sweep consults the coordinator discovery record and **skips
entirely** when a live coordinator is not us — a skip is free, because a sweep failure was never a boot
dependency. A `.mint-*` is removed only by the process that created it, or when it is provably abandoned;
an orphan mint is disk cost, and disk cost is not a reason to delete something a live process may hold.
`release` re-reads `current` and asserts its lease immediately before deleting, and `release 0`
additionally requires that no coordinator is live.

### Two more places where a check was missing and one where it was too strong

**The displaced publisher returns a superseded epoch.** A resolves `e` and stalls; B publishes `e+1`; A
resumes, finds `e` compatible, opens it and returns it, and every write A makes is invisible to current
readers (`epoch.ts:327`). The settle loop must re-verify that the epoch it opened is still the highest
**proven** epoch before returning, and iterate if it is not. This is the one check the design genuinely
needs, and it is cheap and safe precisely because failing it is not a refusal — it is another pass.

**The loop needs a liveness property.** Each iteration must return, or observe a strictly greater proven
epoch. Observing neither is an anomaly to report, not to spin on.

**The adoption lock still refuses to boot.** Acquisition times out after five seconds while a dead owner
is not stale for ten minutes, and the timeout becomes `legacy_source_not_quiescent` thrown out of startup
(`generation-mutation-coordination.ts:102`, `:173`, `:205`, `active-store-selection-coordination.ts:348`).
A process that died without unwinding therefore blocks every boot for ten minutes — this document's
subject, in the mechanism Revision 14 said would become harmless. **The lock is an optimization: failing to
acquire it means proceed without it.** The settle loop is correct with no lock at all; that is the whole
point of the redesign.

### Honesty at the boundaries

`release` returns `released` before syncing the parent, so a power loss can resurrect what the CLI called
permanent (`epoch.ts:174`, `:192`). An adopter that finds a visible epoch after the publisher died between
`rename` and the directory sync does not sync it either (`:275`, `:280`), so a later power loss can discard
an epoch it has already written to. Missing, malformed and unreadable `epoch.json` all collapse to `null`
(`:375`) and render as `legacy-epoch-0` even on epoch 2 — three dispositions wearing one value, which §11
names exactly. `listStoreEpochs` reads the directory twice and can return no row marked current (`:408`).
And `retainActiveStoreTransition` ignores `syncDirectory`'s boolean and audits success anyway
(`active-store-selection-coordination.ts:110`, `:143`).

### One thing that is not a code defect

`clients/hooks/pre-compact.mjs` still opens the flat `<dbDir>/store.db` (`:24`, `:56`, `:70`, `:91`), so
after the first reset it reads the preserved store and after epoch 0 is swept it reports nothing. That is
an ordinary miss. What is not ordinary is that `tests/invariants/client-path-parity.test.ts` was
**edited to affirm the obsolete flat path** rather than failing. An invariant that is changed to match the
code it was written to constrain has been deleted, whatever the diff says.

## Revision 16 — the third answer, in the four places it was collapsed

Round 23's reviewers reproduced five and seven blocking failures respectively, and after deduplication
**four of them are one mistake**, made once per site:

> "Not proven" was collapsed into whichever binary each site already had.

| site                                        | the third answer became                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `currentProvenEpoch` (`src/store/epoch.ts`) | **epoch 0 is proven** — the accumulator is initialised to `0`, so "nothing proven" and "epoch 0 proven" are the same value |
| the sweep (`:302`, `:485`)                  | **garbage, delete it** — `missing`, `malformed` and `unreadable` all reduce to `proven: false`                             |
| liveness (`:257`)                           | **nobody is live** — a missing `coordinator.json` reads as `absent`, which permits deletion                                |
| the settle loop (`:442`)                    | **no progress, refuse** — an unobservable entry blocks the rename and the loop throws                                      |

This is `design-philosophy.md` §11 verbatim — _"the recurring defect is collapsing it into whichever
binary the site already had"_ — in a document that has quoted that rule since Revision 1. What each
collapse produced, all reproduced by a reviewer in an isolated directory:

- A flat `store.db` that is a **symlink to an external compatible database** is not proven, so epoch 0 is
  selected anyway, and writable pragmas and version stamps land in that external database. An insert
  through the returned handle appeared outside `<dbDir>`.
- Epoch 1 is valid and published, but reading its `epoch.json` returns `EACCES` or a transient `EIO`, so
  the sweep classifies it unproven and **recursively removes a live published epoch** — in the `EIO` case
  while settlement still holds it open.
- An incompatible epoch 0 beside a non-empty malformed `epoch-1/` publishes onto `epoch-1`, gets
  `ENOTEMPTY`, never advances, and **refuses the boot**: `Store epoch settlement made no progress beyond
epoch 0.` A regular file named `epoch-1` gives `ENOTDIR`, which is not even handled and escapes.

So the distinction is three-valued, and the dispositions differ in every direction:

> **`proven` authorizes opening and counts toward `current`. `disproven` — a regular file, a symlink, a
> directory with no `store.db`, a name Coral could not have written — is garbage: it may be deleted and
> it may be renamed over. `unobservable` is neither: it never counts, it is never deleted, and it never
> blocks progress.**

That last clause is what makes the loop terminate. The successor is not `current + 1`; it is **the lowest
valid number above `current` whose name is free or disproven**. An unobservable `epoch-1` is stepped over
to `epoch-2` rather than contended against forever.

### The namespace must be closed under successor

Both reviewers found the numeric ceiling from opposite sides: `epoch-<MAX_SAFE_INTEGER>` is rejected by
the parser but publishable, and `epoch-<MAX_SAFE_INTEGER−1>` is accepted while its successor is not, so
the loop publishes a directory it will then ignore and refuse beside. Any finite cap has this shape one
below it.

> **If `N` is a valid epoch number then `N + 1` is a valid epoch number.**

Which forces the representation: epoch numbers are decimal strings compared as `bigint`. There is no
ceiling, no unrepresentable successor, and no state where publication succeeds into a name discovery
cannot see.

### Proof must bind to the object that is opened

Positive epochs are proved by `lstat` and `realpath` on a pathname, and `DatabaseSync` then opens that
pathname again (`:105`, `:130`, `:418`, `db.ts:349`). A same-user process that swaps the directory for a
symlink in between reaches the substituted database, and restoring the original afterwards lets
re-verification pass while the descriptor stays bound to the substitute.

A proof about a name is not a proof about an object. Prove the object: open with no-follow where the
platform allows it, and after the database is open re-`lstat` the proven path and compare `{dev, ino}`
with what was proved — a mismatch closes the handle and iterates. Iterating is free here, which is the
whole reason this design can afford to check.

### Liveness needs evidence, and a missing record is not evidence

`coordinator.json` absent reads as "nobody is live", but `writeDiscoveryRecord`
(`src/infra/backend-discovery.ts`) can return without writing on `ENOENT`, and `probeCoordinator` then
reports the missing record as absent. `store-reset report <K>` opens an epoch in a **child that publishes
no record at all** inside `defaultDependencies` (`src/cli/store-reset.ts`). A reviewer deleted a flat
epoch-0 database out from under a live child, and
another deleted an epoch beneath the `report` diagnostic.

Absent is unobservable, so the sweep skips — which costs nothing, because the sweep was never a boot
dependency. And a process this system spawns to hold an epoch open registers that it holds it; the
`report` child is ours, so it can say so.

### Three more, each small and each a promise the code does not keep

**The sweep has no durability barrier.** Operator release syncs `<dbDir>`; the boot sweep removes and
returns without one (`:270`, `:294`, `:428`). A power loss resurrects the entries, the next publication's
pre-sweep sync makes them durable beside the new epoch, and K repetitions accumulate K old epochs.
"Exactly one" is not crash-safe until the sweep syncs its parent.

**`release` deletes against a stale `current`.** It resolves `current` once and passes the number into
the sweep, which reasserts the lease but never recomputes (`operator-store-reset.ts:162`, `:165`,
`epoch.ts:270`). A transient `EIO` on epoch 2's metadata makes `current` fall back to 1, and `release 2`
then removes the real current epoch and reports `released`. The re-read must be inside the same proof
that authorizes the delete.

**`failStoreEpoch()` is a one-line helper that hides `throw new Error(message)`** (`epoch.ts:212`). It
violates §9, and worse, its six call sites collapse into a single AST `ThrowStatement`, so the
semantic-refusal ratchet counts six startup refusals as one and a seventh would not move it. **A guard
that can be disarmed by extracting a helper was disarmed by extracting a helper.** Inline the throws.

### One selector, not two

`clients/hooks/lib/store-epoch.mjs` reimplements the epoch grammar, the numeric bound, the metadata
schema, containment, the regular-file proof and highest-epoch selection, all of which `src/store/epoch.ts`
owns. Hooks may not import from `src/`, and that constraint does not make a second canonical home
acceptable under §7 — it makes it a build problem. Either the hook's copy is generated from the owner at
build time, or the parity invariant runs both implementations over one shared corpus of proof states so
drift fails rather than passes. The current parity test supplies one valid epoch and one symlink, which
is not a corpus.

## Revision 17 — the sweep that never runs, and a defence that was never owed

Round 24's reviewers reproduced seven blocking failures each, in isolated directories. Two are design
errors rather than implementation gaps, and one of those is mine from Revision 16.

### The sweep has no reachable opportunity

Settlement runs — and performs its only sweep — **before** `runLifecycleStartup` publishes the coordinator's
discovery record (`src/coordinator/lifecycle.ts`), and a clean shutdown removes that record. Under
Revision 16's rule that an absent record is unobservable, every boot sweep therefore returns `incomplete`,
and every `release` of a non-current epoch is refused: while the daemon is live the record names a
different PID, and after a clean stop there is no record at all. **The only state that permits a
successful release is a stale record naming a dead process**, and the remediation text asks the operator
to confirm no coordinator holds the epoch through a command that does not exist.

So "keep exactly one" never converges in ordinary use, and both reviewers demonstrated K garbage epochs
accumulating across clean start/reset/stop cycles. The rule from Revision 16 is right; its placement was
wrong.

> **The sweep is not a boot step. It runs after the coordinator has published its discovery record**,
> where the record exists, names us, and an absence genuinely means no coordinator is live.

That is what "the sweep was never a boot dependency" should have meant all along, and it costs nothing:
the boot opens its epoch and proceeds, and retention converges a moment later. `release` gains the same
footing, plus an operator path that does not depend on a corpse.

A record that **is** present while its PID is absent is also not `absent`. It says a coordinator died; it
says nothing about the children it spawned. A reviewer used exactly that to delete an epoch
`createKbDaemonWriteRuntimeHost` still had open (`src/kb-daemon/runtime-host.ts`). Present-but-dead is
unobservable.

### A defence that was never owed

Five of the remaining findings are one mechanism defending against one adversary:

- Containment is proved by `lstat`/`realpath` on the directory, and `O_NOFOLLOW` then protects only the
  final `store.db` component (`epoch.ts:159`, `:181`). Replacing `epoch-1` with a symlink to an external
  directory **after** containment succeeds reaches an external database, and Coral stamps it.
- The `/proc/self/fd` bridge binds an inode but not the name SQLite derives `-wal` and `-shm` from. A
  reviewer renamed `store.db` to `moved.db` after the descriptor was taken and restored the proved inode
  before re-verification: `{dev, ino}` matched, `db.location()` was `moved.db`, WAL lived at
  `moved.db-wal`, and a peer opening `store.db` got `disk I/O error`.
- Where neither `/proc/self/fd` nor `/dev/fd` exists the code falls back to the mutable pathname, silently
  defeating the binding it advertises.

Each fix would be another turn of the same screw, so ask instead who this defends against: a process
running **as the same user** that actively races the coordinator inside `~/.coral`. That process can
already replace the plugin bundle, the CLI, the hook scripts and the coordinator binary. There is nothing
here to protect that it cannot reach more directly, and the owner's position is that the store matters to
nobody.

> **A same-user process that actively races the coordinator is out of scope, and that is written down
> rather than defended against.**

So the descriptor bridge, `O_NOFOLLOW`, the post-open re-verification and the platform fallback all go, and
SQLite is handed the path. What stays is the cheap static classification the trichotomy actually needs:
a `store.db` that _is_ a symlink, a directory that _is_ a symlink, an entry of the wrong kind — these are
accidental states, they are disproven, and `lstat` decides them without pretending to be atomic.

### Deletion still acts on a classification it no longer holds

`replaceEpoch` observes an entry as disproven and then removes it by pathname with no holder or liveness
check at all (`epoch.ts:394`); the sweep and `cleanupMint` have the same observation-to-`rmSync` gap
(`:465`, `:501`). Two publishers see a malformed `epoch-1`; B removes it, publishes a valid `epoch-1` and
opens it; A resumes from its stale observation and deletes B's live epoch. Reproduced.

The replacement arm should not exist.

> **The successor is the lowest valid number above `current` whose name is free** — not free-or-disproven.

Nothing has to be deleted in order to publish, `ENOTEMPTY` and `ENOTDIR` simply advance the number, and
`replaceEpoch` goes with the race it carried. Disproven garbage is then swept, post-ready, by the same
pass that handles old epochs — where a concurrent publication cannot appear, because publication only ever
moves upward.

### Three more

**A persistent open failure spins forever.** `openProvenStoreDescriptor` catches everything and returns
`null` (`:581`), `tryOpenCurrentEpoch` turns that into `retry` (`:628`), and settlement repeats with no
observed progress (`:677`). A `store.db` at mode `0444` busy-spins. A proven epoch that cannot be opened
names a refused syscall, which is the one refusal the governing rule allows — surface it rather than
looping.

**The holder record has no lifecycle.** Before this revision, the report parent wrote it atomically, while
the diagnostic child then truncated and rewrote the same path with a plain writeFileSync, so a death
mid-write leaves malformed JSON that is classified unobservable forever, blocking every later sweep and
release with no command to clear it. The parent writes it once, naming the epoch and the PID; the child
never rewrites it; the parent removes it in `finally`; a record whose PID is absent is stale, visible in
`list`, and removable by the sweep that re-checks it. Revision 32 later deletes the report parent,
diagnostic child, and their holder records entirely.

**`incomplete` collapses five outcomes** — unobservable metadata, a live holder, an unobservable holder,
a failed deletion and a failed durability sync — and `release` maps all of them to `release-unproven`
whose only advice in `formatStoreResetRelease` is to confirm no coordinator holds the epoch (`epoch.ts:392`,
`operator-store-reset.ts:157`, `src/cli/format/store-reset.ts`). They have different successors and must
say so.

**`epoch.json` is read without a byte bound on the boot path** (`:769`). A bound here is correct and is
not this document's subject: exceeding it makes the metadata **malformed**, which is a classification, not
a refusal.

## Revision 18 — carry the epoch you opened, and never sweep on the event loop

Round 25's reviewers confirmed publication and the static classification again, and found two things the
epoch design had not yet been asked: who knows which epoch is open, and where the sweep runs.

### The decision is made once and then re-derived by everyone

`settleStoreEpoch` returns the exact `{db, epoch, path}` it opened and `coordinateActiveStoreSelection`
preserves it (`src/store/active-store-selection-coordination.ts`), and then
`routeOrOpenBackendStoreAtStartup` **drops `epoch` and `path` and returns only `db`**
(`src/store/startup-store-routing.ts`). Three consumers therefore re-derive it independently: the
post-ready sweep in `scheduleStoreEpochSweepFn` (`src/coordinator/composition/index.ts`), the KB daemon in
`createKbDaemonWriteRuntimeHost` (`src/kb-daemon/runtime-host.ts`), and `release`.

A reviewer walked it through: epoch 3's `epoch.json` returns a transient `EIO`, so it is unobservable and
startup opens the older compatible epoch 1; the metadata becomes readable a moment later; the sweep
resolves `current = 3` and **deletes the database the coordinator has open**. The same divergence lets the
coordinator and the KB daemon write to two different epochs, and lets `release 1` unlink a live
coordinator's epoch because a restored `epoch-3` made 1 look old (`epoch.ts:477`, `:493`) — with an
integration test that asserts the unsafe outcome.

The whole point of the design is that the epoch is chosen once, atomically. Re-deriving it is choosing
again.

> **The epoch a process opened is carried, not recomputed — and the coordinator's discovery record names
> it.**

`routeOrOpenBackendStoreAtStartup` stops narrowing the result. The sweep is told which epoch is open. The
KB daemon is told by its parent rather than resolving for itself. And the discovery record gains the
epoch alongside the PID it already carries — additively, tolerantly read, per §10 — so `release` can
refuse any epoch a live coordinator has open rather than only the one it computes as current.

### A sweep that blocks the event loop is this document's subject in a new costume

The post-ready sweep is scheduled with `setTimeout(0)` in `scheduleStoreEpochSweepFn`
(`src/coordinator/composition/index.ts`) and then performs the entire pass **synchronously**: recursive
`rmSync`, a full scan, and a durable directory sync (`epoch.ts:319`, `:524`, `:560`). Both reviewers
reached the same place — a large or deep accidental `epoch-*` tree blocks the coordinator's event loop,
the waiting client's authenticated health request in `waitForBackendReady` (`src/transport/ipc/ensure.ts`)
times out, and signal-driven shutdown waits too.

A coordinator that cannot answer because it is deleting a big directory is the coordinator that could not
start because it was hashing a big file. The mechanism changed; the shape did not.

> **The sweep never runs on the coordinator's event loop.** It uses asynchronous filesystem operations
> and yields between entries, so no single pass can make the coordinator unobservable.

### The holder must name the process that holds

The holder record named the CLI parent's PID, while SQLite was opened by its diagnostic child. Two
consequences, both reproduced: a parent killed with SIGKILL leaves a record naming a dead PID while its
child still holds the database, and the next sweep reaps the record as stale and unlinks underneath it;
and on `termination_unconfirmed` the child is **detached while possibly still live** while the parent
removes the marker anyway. Revision 32 removes this entire process relationship rather than carrying its
holder protocol forward.

The second is §11 exactly — unknown authorizing finalization — and the test in
`tests/integration/cli/store-reset.test.ts` currently requires it. The record names the process that
opens the database, and an unconfirmed termination leaves the protection in place; the record's own
staleness is then decided by that PID, not by its parent's.

### Four smaller ones, each an exit that does not exist

**`discard` leaks its socket guard.** The guard is acquired before the adoption lock but the cleanup
block starts after it (`operator-store-reset.ts:129`), so a lock timeout leaves the CLI holding the
coordinator's sockets and nothing can start until it is killed.

**Two release dispositions advertise a retry that cannot complete.** Release short-circuits on `absent`
(`epoch.ts:431`), so a deletion that succeeded with a failed durability sync retries into "absent" and
never re-syncs, and epoch zero's `store.db` is removed before its WAL, SHM and sidecar so a later unlink
failure orphans them permanently. §11 requires the successor to exist.

**A `<dbDir>/store.db` that is a directory can never be removed.** It is correctly disproven
(`epoch.ts:148`) and then removed with `unlinkSync` because flat members are assumed to be files
(`:502`, `:549`), returning `EISDIR` on every cycle while the remediation says to retry.

**Two unbounded loops.** A persistent non-`ENOENT` `lstat` on successor candidates advances the integer
forever (`:577`) — a store directory readable but not executable does this — and orphaned `.mint-*`
directories are removed only by their creator's `finally` (`:603`, `:634`), so K process deaths leave K
initialized SQLite mints and eventually `ENOSPC`. A persistent observation failure names a refused
syscall and is surfaced; an abandoned mint is reclaimed by the post-ready sweep, which now runs where it
can see that no one owns it.

## Revision 19 — retention is ordinal, and every holder holds a lock

Round 26's reviewers confirmed publication, the carried epoch and the asynchronous sweep, and then found
that **the sweep can leave zero copies** — the one outcome the owner's rule forbids in both directions,
and a consequence of something I wrote two revisions ago.

### `current − 2` stopped meaning "older than the preserved copy"

Revision 17 made the successor skip over a blocked name: an incompatible flat epoch 0 beside an
unusable `epoch-1` publishes `epoch-2`. Retention still defines garbage arithmetically as
`candidate <= current - 2` (`garbageStoreEpochs` in `src/store/epoch.ts`), so the sweep removes the blocker **and epoch 0**,
and the only survivor is the freshly minted epoch 2. No preserved copy at all. The existing cell builds
exactly this state and asserts only that the blocker disappeared
(`publishes after a successor blocked` in `tests/integration/store/open-or-reset.test.ts`).

Once the numbering can gap, "one less than current" is not "the previous epoch".

> **Retention is ordinal, not arithmetic: sort the proven epochs, keep the highest two, delete the rest.**

That is what "newest wins, keep exactly one" has meant since Revision 9, expressed as the operation it
actually is. It is immune to gaps, it deletes the `epoch-0`-versus-`epoch-2` special cases with it, and
the property test becomes a statement about a sorted list rather than about subtraction.

**Epoch 0 is removable only by an explicit `release 0`.** A rolled-back build's live store is always the
flat name, and a `v0.10.9` discovery record cannot carry `storeEpoch` to say so. One store's disk is the
whole cost of never deleting a rolled-back coordinator's database.

### Every process that opens a store holds a lock while it does

Three findings are one gap. The post-ready sweep removes any `.mint-*` in its opening snapshot without
proving it is abandoned, so a concurrent publisher's mint disappears between its creation and its rename;
`mintNextEpoch` then sees `ENOENT` and settlement **throws instead of re-minting** (`:861`, `:869`,
`:949`) — with a test that expects the throw (`open-or-reset.test.ts:582`), against Revision 14's
explicit `ENOENT: continue`. An orphaned KB daemon holding epoch 1 has no record at all, so the sweep
unlinks it (`stopForParentExit` in `src/kb-daemon/daemon-main.ts`). And a diagnostic holder published _after_ the sweep's
snapshot is deleted anyway; a reviewer produced `result=complete epoch1Exists=false holderStillLive=true`.

PID-only identity makes the opposite failure just as reachable: after the child exits, PID reuse by any
long-lived process makes every sweep and release answer `live-holder` forever, and the remediation names a
process that no longer exists. Revision 32 deletes the diagnostic process and its holder; ordinary epoch
leases remain lock-based.

> **A process that opens a store holds a lock on it for as long as it holds the database, and liveness is
> "can I take that lock", not "is this PID alive".**

The lock is the mechanism this repository already has (`src/infra/fs-lock.ts`). It cannot be defeated by
PID reuse, it is released by the kernel when the holder dies however it dies, and taking it is the same
act as proving the holder is gone — which closes the snapshot-to-deletion gap without another re-read.
Coordinators, KB daemons, diagnostic children and mints all hold one; a mint is reclaimable exactly when
its lock is free.

### The sweep must not outlive the authority that started it

The post-ready sweep's timer and promise are discarded unreferenced
(`scheduleStoreEpochSweepFn` in `src/coordinator/composition/index.ts`), so shutdown cannot cancel or join it. It can therefore resume
after the coordinator has released its socket and removed its discovery record, and unlink epoch zero
under a rolled-back build that has since started, or a live mint belonging to a successor
(`runShutdownSequence` in `src/coordinator/shutdown.ts`, `createLifecycle` in `src/coordinator/lifecycle.ts`). It is a lifecycle obligation: tracked, cancelled
before destructive steps, joined before addresses are released.

And `swept` must reach its documented successor — re-mint — rather than a boot refusal.

### Release needs the evidence it already has available

`release` permits an absent discovery record (`epoch.ts:480`) and then re-resolves current and deletes
(`:498`), so a coordinator that opened epoch 1 during a transient metadata `EIO` — before its record was
written, or after a swallowed `ENOENT` write returned false (`writeDiscoveryRecord` in
`src/infra/backend-discovery.ts`, `writeAtomicSyncNode` in `src/runtime/real.ts`) — loses its open epoch to `release 1`. A reviewer reproduced
`kind=released epoch1Exists=false descriptorOpen=true`.

`discard` already binds the coordinator sockets to prove no coordinator is live. `release` takes the same
guard, which is decisive where a missing file is not. Discovery publication also stops discarding its
failure.

### Two smaller ones

The asynchronous sweep still does unbounded synchronous work: `JSON.parse` on a holder file of any size
(`:679`), and two non-yielding O(N) passes over the directory (`:747`, `:769`). Bound the read and yield
inside the scans; the responsiveness cell should scale, not sit at 300 entries.

And the hook's second selector still disagrees with the canonical one: the backend rejects an
`epoch.json` over 64 KiB and the hook reads it unbounded (`readEpochMetadata` in `src/store/epoch.ts`,
`isPublishedEpoch` in `clients/hooks/lib/store-epoch.mjs`), so a 70 KB valid document makes the backend choose epoch 1 while
`pre-compact` opens epoch 2 — reproduced. §7 has been asking for one home since Revision 15; the parity
corpus keeps being a sample rather than a proof. Generate the hook's copy from the owner.

## Revision 20 — the lock is only a proof if everyone takes it

Round 27's reviewers confirmed ordinal retention, the generated hook, and the lock primitive's death
semantics among participating processes, and then found the assumption underneath all of it:

> Successful exclusive acquisition proves that no one holds the database **only in a closed world**, and
> the world is not closed.

`openReadOnlyStoreDatabase` in `src/store/read-port.ts` resolves the current epoch and opens SQLite with no shared
lock; `getSharedReadCoralStore` in `src/cli/read-store.ts` caches that handle for the command's life;
`openLockedReadOnlyStoreDatabase` in `clients/hooks/pre-compact.mjs` opens one for `pre-compact`; even
`classifyStoreFile` in `src/store/db.ts` classifies `store-reset list` through an unprotected read-only handle. A
reviewer's probe took the exclusive lock, removed the epoch, and watched the reader keep querying — which
was offered as reassurance and is the opposite. **Recursive removal deletes `store.db-wal` and
`store.db-shm` out from under an open connection**, and that is SQLite's own documented corruption case,
not a harmless POSIX unlink. I had been about to write down that unlinking an open database is safe;
checking the citation is what stopped me.

> **Every canonical opener takes the shared lock for as long as it holds the database.** The read-only
> port, the CLI's cached reader, the classification handle inside `list`, and the generated hook all
> participate — the hook with a bounded, fail-open equivalent, since it is generated from the same owner.

One opener cannot participate, and it is the reason epoch 0 is already exempt from automatic sweeping: a
`v0.10.9` build knows nothing about epoch locks. That leaves exactly one hole, **explicit `release 0`**,
and it is on an operator path. It says what it cannot prove — that no pre-epoch build holds the flat
database — and proceeds only on the operator's explicit confirmation. That is §11's authority empowered to
override uncertainty, and it is not a boot refusal.

Revision 14's sentence was also too strong and is corrected here: **nothing renames or replaces a database
a live writer holds, and no automatic path deletes one.** Deletion under an explicit operator command,
having said what it could not prove, is a different act.

### One contended lock stops the whole pass

The deletion loop in `sweepStoreEpochsPostReady` in `src/store/epoch.ts` returns `live-holder` on its **first**
contended lock; `sweepStoreEpochs` in `src/store/epoch.ts` has the same shape, skipping every later garbage entry
and the final directory sync. An orphaned holder on old epoch 1 therefore stops the pass wherever
`readdir` places it — a stable ordering — so K later discards accumulate forever, and any entry already
removed in that pass loses its durability barrier and can be resurrected by a power loss.

A contended entry is a **skip, not a stop**. The pass continues, reports per-entry dispositions, and syncs
at the end.

### Three boundaries that say more than they established

**`release` can claim a removal it never attempted.** Stale-holder cleanup in `sweepStoreEpochs` in
`src/store/epoch.ts` runs first; if its directory sync then fails, it returns `durability-sync-failed` **before
reaching the target**, and `releaseStoreReset` in `src/store/operator-store-reset.ts` maps every such result to one
variant whose `formatStoreResetRelease` in `src/cli/format/store-reset.ts` says the epoch "was removed". One result
carrying a pre-deletion and a post-deletion disposition is
`decision-union-results.md` exactly.

**The sweep's join is delegable, so it can outlive the authority that started it.** `runShutdownSequence` in
`src/coordinator/shutdown.ts` registers the cancellation join as a `process-exit` remainder; when the drain budget
expires, `SettlementLedger` in `src/obligation/settlement.ts` accepts the remainder and commits the
authority-release boundary, after which `shutdown` in `src/coordinator/lifecycle.ts` removes discovery while a
destructive `rm` may still be in flight. A second signal only awaits the same cached promise through `main` in
`src/coordinator/bootstrap.ts`. No _new_ deletion starts after
cancellation, so the syscall qualification in Revision 19 was honest; the stronger claim that the sweep is
joined before addresses are released was not. This join is not delegable.

**A `StoreCodecError` abandons a live job.** `handleProviderJobError` in `src/jobs/shell/launch.ts` returns early
when reading current status meets a malformed persisted event, and `runAsync` in `src/jobs/shell/launch.ts`
releases the launch permit but not the abort-registry entry or the session claim. A malformed latest event for a
live job whose provider then fails leaves no terminal and a
stranded claim — tolerance without the visible durable disposition §10 and §11 both require. It arrived as
collateral from a shutdown-ordering change, which is how this kind of thing always arrives.

### Two leaks

Every exclusive probe creates `.epoch-lock-<N>.sqlite` and positive-epoch deletion leaves it behind,
because the then-current sweep defaults its separate lock-path cleanup to false. K publications leave O(K) entries
that every future scan walks. They need a race-safe reclamation — the lock file is removable exactly when
its own lock is free, which is the same proof the sweep already performs.

And a directory literally named `epoch-0` is accepted by `EPOCH_DIRECTORY_PATTERN` in `src/store/epoch.ts` but
skipped by both observers, so it is neither proven, nor disproven, nor garbage, and survives every cycle at
any size. `epoch-0` is not a valid epoch directory name: the flat `store.db` is epoch 0's only address.

## Revision 21 — the flat name belongs to the previous generation

The owner corrected the premise again, and this one is mine from Revision 14.

`epoch-*` is introduced by this release. `v0.10.9` knows only `<dbDir>/store.db`. I made the flat name
**epoch 0** — a member of the new number space — and then spent Revisions 19 and 20 building exemptions to
keep it safe: retention exempts it, automatic sweeping never touches it, `release 0` carries a
legacy-reader override that states what it cannot prove. Every one of those exemptions exists because two
generations were forced into one number space that only one of them understands.

> **The flat `store.db` is the previous generation's artifact. This build never opens it, never locks it,
> and never deletes it. The epoch space starts at 1.**

Retention then becomes the owner's sentence with nothing added: **sort the proven epochs, keep the highest
two.** Two, not three. `garbageStoreEpochs` loses `retained.add('0')` and the rule is the whole
implementation.

### What it deletes

Epoch 0 is threaded through roughly twenty sites in `src/store/epoch.ts` — `epochPath`'s special case,
two proof paths (sync and async) that accept a regular file as an epoch, the listing skip, the retention
exemption, the release target special case, the flat-name unlink path, a dedicated lock coordinate. All of
it goes, and with it:

- `release 0` and its "cannot prove no pre-epoch reader" confirmation.
- The question of whether a directory named `epoch-0` is valid, which cost a finding.
- Every deletion-safety cell for the removed epoch-zero release machinery. One rolled-back-reader cell remains
  to prove that publication and sweep never address the flat name at all. The hazard is gone by construction
  rather than by exemption. That was Revision 20's remaining hole and it closes without a mechanism.

`legacy-adoptable` does **not** follow them out. It is produced when the fingerprint matches and the
product-version row is absent — see `classifyStoreFormat` in `src/store/db.ts` — which no epoch writer
can produce because `applyBundledStoreSchema` stamps both rows. But `classifyStoreFile` also serves the
pre-epoch legacy-generation store, reached from `inspectGenerationReadiness` in
`src/store/generation-mutation-coordination.ts`, which this design does not touch. Verify reachability there before removing anything; Revision 12's adoption stays correct where it
is still reachable.

### The cost, stated

A first boot from `v0.10.9` becomes an **unconditional reset**: a compatible flat store is no longer
adopted, because it is no longer read. The population that loses anything is empty — `src/store/schema.sql`
already changed, so the fingerprint already differs and that boot already resets — and going forward
nothing writes the flat name again, so it cannot become compatible later. Unconditional reset was the
owner's starting position.

A rolled-back `v0.10.9` finds its store exactly as it left it, because nothing in the new build has an
address for it.

### Why neither reviewer found this

Twenty-eight review rounds did not question epoch 0, and the reason is in the briefs rather than in the
reviewers. I wrote the review scope, so the premises entered it as givens — and for retention I protected
them explicitly: _"do not report the absence of those mechanisms as a finding, and do not propose new
retention rules."_ That instruction was aimed at re-litigating the owner's decision, and it also fenced
off the question of whether my encoding of that decision was right.

Reviewers checked the implementation against the design. Nobody checked the design against the purpose.
The one time that question was asked outside the fence — the pioneer, Revision 14 — the premise broke
immediately. Review briefs from here name their own premises as the first thing to attack.

## Revision 22 — the lock is born with the store and dies with it

Round 32's reviewers confirmed the positive-epoch topology, retention, publication and listing, and then
falsified Revision 21's central claim in two production entrypoints and found two ways the sweep can
delete a live store through lock-file identity.

### "Never opens the flat store" was false on the ordinary boot path

Startup calls `inspectGenerationReadiness` **before** epoch settlement, and that passes the legacy flat
`store.db` to `classifyStoreFile`, which opens SQLite read-only. A reviewer reproduced the consequence on
a crashed WAL store: the directory went from `store.db + store.db-wal` to
`store.db + store.db-wal + store.db-shm`. **Opening it changed it.** The repository's own test already
acknowledged that classification rewrites legacy sidecars while the operator notice beside it says the
tree "is left untouched".

The second entrypoint is `--smoke-open-store --path <anything>`, dispatched in production bootstrap with
no validation beyond "an argument follows", handed straight to a writable opener. A reviewer pointed it at
the flat store through the built `coral-backend.cjs` and watched `store_product_version` go from absent to
present.

> **Readiness reports what it can see without opening anything.**

Readiness needs to emit an operator notice about a previous-generation store. `existsSync` and `lstat`
answer that. The `classifyStoreFile` call on that path goes, and with it the claim that we can look inside
a database we have promised not to touch. `legacy-adoptable` then has no reachable producer at all —
`inspectGenerationReadiness` was the last one, and it only collapsed the result to a `legacy-ignored`
notice anyway — so Revision 12's adoption and its classification arm can be deleted outright. My note in
Revision 21 that "adoption stays correct where it is still reachable" was wrong about where that was.

And the smoke opener's path domain is constrained at the entrypoint: a canonical positive-epoch path or a
private temporary one, validated before it reaches an opener, per the repository's schema-first rule.

### Lock files are root entries, and that is the bug behind both deletions

Two reproduced chains, one cause:

- `.mint-lock-<id>.sqlite` satisfies `entry.startsWith('.mint-')`, so the post-ready sweep classifies a
  live mint's **lock** as an abandoned mint, derives the nonsense id `lock-<id>.sqlite`, guards the
  deletion with an unrelated lock path, unlinks the real lock, and then deletes the publisher's live
  database. Production creates the lock before the directory, so the sweep's snapshot sees them in exactly
  the order that triggers it.
- Orphan-lock cleanup **releases its exclusive lease and then unlinks the pathname**. In that window a
  publisher can take `epoch-1` and an opener a shared lease on the old inode; the unlink then detaches the
  name, later acquirers create a _new_ inode under it and obtain "exclusive" while the live reader holds
  the old one, and the next sweep deletes the live epoch. A reviewer drove the whole chain.

The reviewer's own diagnosis is the design: lock safety rests on stable pathname-to-inode identity, and
the sweep both treats lock files as targets and removes lock pathnames without holding the decisive lease
through removal.

> **A store's lock lives inside the store: `.mint-<id>/.lock`, which becomes `epoch-N/.lock` when the mint
> is published.** One lock file per store, created with it, carried by the same rename that publishes it,
> removed by the same `rm -rf` that removes it.

Nothing in the store root is a lock, so no root entry can be mistaken for one and the `.mint-` prefix
collision cannot be spelled. An epoch's lock cannot outlive its epoch, so **orphan locks do not exist** —
orphan-lock cleanup, tombstone reclamation, the `removeLockFile` family and the pathname-reuse hazard all
go with the concept. And a lease survives the publication rename because the inode does, so the mint's
exclusive lock becomes the epoch's shared lock without a handoff.

One consequence to implement deliberately rather than discover: a mint directory that exists without its
`.lock` is a process caught between `mkdir` and lock creation. That is **unobservable**, not abandoned.

### The operator contract has two reachable no-epoch failures

`discard` resolves the current epoch before `discardCurrentStoreEpoch` creates the store directory, so on
a genuinely new generation it exits `ENOENT: no such file or directory, scandir …` — reproduced through
the installed CLI. And where the directory exists with no proven epoch it prints `Discarded store epoch
null; initialized epoch 1` and warns that the previous epoch remains preserved. The result type already
makes `previousEpoch` nullable; the renderer simply never disposed of that arm.

## Revision 23 — rename before destroying, and prove the lock before opening it

Round 33's architect reproduced two blocking defects in Revision 22's contained lock. The guardian's run
was cut short by the provider's own content filter after contributing one finding, so this round had one
and a half reviewers; that is recorded rather than hidden, and the round should be re-reviewed.

### `rm -rf` erases the lock first, and it is not atomic

`removeWhileExclusivelyLockedAsync` takes the epoch's `.lock` and then recursively removes the directory
**containing that lock** before releasing the lease. Recursive removal is a sequence: `.lock` is unlinked
early, `store.db` later. In that interval another process creates a new `.lock` inode — the shared-lock
helper has create semantics — opens the still-present database, and has it deleted underneath a live
descriptor. The reviewer reproduced it: the sweep returned `complete`, `epoch-1/store.db` was gone, and the
reader's open handle still answered queries.

So moving the lock inside the store did not remove the pathname-reuse hazard; it relocated it into the
deletion itself. **Holding the inode does not preserve pathname-to-inode identity when that pathname is
one of the children being erased.**

The answer is the move this document has used since Revision 4 and never applied to deletion:

> **Rename before destroying.** Under the exclusive lease, `rename(epoch-N → .reaping-<uuid>)` — one
> atomic operation that removes the public address — and only then erase.

An opener arriving afterwards finds `epoch-N` absent, which is the truth, and cannot recreate a lock at an
address that no longer exists. A crash between the rename and the erase leaves a `.reaping-<uuid>` that
the sweep reclaims, which is the same shape as an abandoned mint.

### A lock is opened without being proven

Epoch discovery proves the directory, `epoch.json` and `store.db`, and never inspects `.lock`. Settlement
then hands that pathname to SQLite before either error-conversion block, through a helper that follows
symlinks and accepts anything SQLite can open. Two reproduced consequences:

- A valid current epoch whose `.lock` is a **directory** aborts startup with `unable to open database
file`. That is a new boot refusal, on malformed store state, which is this document's subject.
- A valid current epoch whose `.lock` **symlinks to the crashed legacy WAL store** makes ordinary
  settlement open and reconcile that database — `store.db + store.db-wal` became a reconciled `store.db`,
  and `store.db-shm` appeared. Revision 22 closed two doors into the legacy tree and left this third one
  open, through the very mechanism it introduced.

> **An existing epoch lock is proven before it is opened — regular file, not a symlink, physically
> contained — and a malformed one is a classification, not an escape.**

Creating a mint's lock and opening an existing epoch's lock are different operations with different
preconditions and stop sharing a helper. A `.lock` that cannot be proven makes its epoch unusable, which
routes to the successor mechanism exactly as a corrupt `store.db` does, and never to a throw.

### The smoke opener's domain is lexical, not physical

`storeEpochAtPath` checks the basename and the lexical parent name; it does not prove that `epoch-N` is a
real contained directory. With `epoch-1` symlinked to the legacy directory, the built
`coral-backend.cjs --smoke-open-store` exited 0, created `.lock` in the legacy tree, and raised that
database's product version from `0.10.8` to `0.10.9`. Prove the physical directory and the final database
at the entrypoint.

The guardian added, before its run was cut: the schema accepts a "private temporary" path that can never
succeed, because the native-binding script supplies a fresh `s.db` while the selected opener refuses an
absent file. An accepted input that cannot work is not a domain.

### Lockless mints accumulate silently

Publication exposes the mint directory before creating its lock, so a crash in that interval leaves a
lockless mint; a partial cleanup that erases `.lock` and then fails leaves another, possibly large. The
sweep correctly treats them as unobservable and leaves them, and composition then discards that
disposition — so they grow without bound, without convergence, and without operator-visible status. §11
asks that a hold name what ends it. Either publish into the sweep-visible namespace only after the lock
exists, or give the residue a bounded convergence and a status an operator can read.

### Descriptions were refreshed rather than deleted

`conventions.md` states that editing a descriptive comment to keep it true as the code changes is itself a
finding. Revision 22 did it three times: the diagnostic-marker comment moved from "reaped after its pid is
observed absent" to "reaped when its epoch lock proves no live holder"; the classification union comment
was restated after `legacy-adoptable` was deleted; and a test comment still asserts that legacy
classification opens SQLite and rewrites sidecars, which this revision removed. All three describe code
rather than constrain it. Delete them.

## Revision 24 — proof has three parts, and we were doing one and a half

Round 34's reviewers confirmed rename-before-destroy, the disjoint residue namespaces, the lock carried
through publication, and the corrected fixtures. Then both found the same thing from opposite ends:
**`lstat` plus `realpath` establishes filesystem kind and lexical placement, and nothing else.**

Proof of a store artifact has three parts:

1. the **kind** — a regular file, a real directory, not a symlink;
2. **inode identity** — this object is not also reachable as another object we promised not to touch;
3. **protocol validity** — a file that is supposed to be a SQLite lock actually is one.

Shape checks give the first and a lexical version of the second. Both reproduced failures live in the gap.

### Hard links walk straight through containment

`epoch-1/store.db` hard-linked to the flat `<dbDir>/store.db` passes every check: it is a regular file,
it is not a symlink, and `realpath` returns its own lexical pathname, so containment "holds". A reviewer
drove the built `coral-backend.cjs --smoke-open-store` at it and the flat legacy database went from zero
to forty-five schema objects and gained `store_product_version=0.10.9`. Same inode, `nlink=2`. The
generated hook repeats the check and therefore the hole.

> **A required epoch file with `nlink !== 1` is not proven.**

This rule is not new to this document. Hard-link alias protection was in the design before Revision 14 and
both reviewers of the day confirmed it sound; the rewrite dropped it and nothing noticed for twenty
rounds. That is the class of loss the briefs now ask reviewers to hunt for, and it took until someone
tried the alias to find it.

### A read-only command rewrites databases outside the store

`observeContainedRegularFile` proves a child against **the supplied directory's resolved path** and never
proves that the supplied directory is itself real and contained. Holder inspection and residue listing
both call it that way, and then open the resulting `.lock` read-write with `BEGIN EXCLUSIVE`. With
`.reaping-alias` symlinked to an external directory holding a crashed WAL database, `store-reset list`
exited 0, reported the residue reclaimable, grew that external `.lock` from 4096 to 8192 bytes and deleted
its `-wal` and `-shm`. Reproduced through the built CLI, twice, the second time through a holder record
pointing at an aliased epoch.

Two separable mistakes, and both need fixing:

- **A directory is proven before its children are.** One shared observation of a residue or epoch root,
  consumed by listing, holder inspection and the sweep alike.
- **`list` is read-only and must not acquire anything.** Deciding liveness by taking an exclusive lock is
  a mutation, and a reporting command that mutates is wrong even where the target is canonical. Listing
  reports liveness as unknown, or through a probe that cannot write.

### A window between `mkdir` and the lock, which ends as a boot exception

`createSharedFileLockSync` exposes the preparation directory with `mkdirSync` before constructing
`.lock`, and every `.preparing-*` entry is sweepable. A reaper that observes the directory with no lock
renames and deletes it; the publisher's `new DatabaseSync` then fails with `ERR_SQLITE_ERROR: unable to
open database file` — **not** `ENOENT`, confirmed on Node 26.3.1 — and `mintNextEpoch` retries only
`ENOENT`, so it escapes through settlement as a refusal to boot.

An artifact enters the sweepable namespace only when it is complete. Prepare outside it and rename in,
which is the mechanism this document already uses for publication and for reaping.

### A lock that is a regular file but not a database

A `.lock` containing arbitrary bytes is "proven" by shape, and the exclusive opener then throws
`SQLITE_NOTADB` for it; both removal paths collapse that into `target-failed` **before** the rename, so
the residue can never be reclaimed and accumulates without bound, with `release` able to say only
`release-deletion-failed`.

> **Lock acquisition answers four ways: acquired, contended, malformed, unobservable.**

`SQLITE_NOTADB` is decisive — the file is not a lock — so it is disproven and the artifact is renamed and
destroyed like any other garbage. Genuine I/O uncertainty stays unobservable and stays untouched. That is
§11's three answers plus the one this site actually needs.

### Two small ones

A wrong-kind residue root — a regular file named `.mint-x` — is reported `unobservable` because probing
`<file>/.lock` yields `ENOTDIR` and only `ENOENT` maps to disproven, while the sweep looks at the root
itself and reclaims it correctly. The operator status and the behaviour disagree; one shared observation
fixes both.

And `scripts/verify-native-binding.sh` had its header comment rewritten to describe the new smoke
workflow instead of the old one. `conventions.md` makes an edited description a finding in its own right.
Delete it.

## Revision 25 — the device is part of the identity, and reporting does not open

Round 35's architect reproduced three blocking failures; the guardian independently reproduced two of the
three before its run was stopped by the provider's content filter, as in round 33. **Two of the three were
introduced by Revision 24's own fixes**, which is now the recurring shape: each new mechanism arrives with
its own hazard.

### A bind mount satisfies every part of the proof

Revision 24 added `nlink === 1` to kind and lexical containment, and a bind-mounted file over
`epoch-1/store.db` satisfies all three. A reviewer bind-mounted an external empty SQLite file there, ran
the built `coral-backend.cjs --smoke-open-store`, and watched the external database go from zero to
forty-five schema objects with `store_product_version=0.10.9`. Ordinary startup reaches the same writable
settlement. Deletion has the mirror of it: a bind-mounted external directory named like a holder is marked
removable and recursive `rmSync` empties it.

`realpath` cannot see a mount, and `nlink` counts links within a filesystem, not across one. The missing
axis is the one `stat` already reports:

> **An artifact is proven only if its `dev` is the store directory's `dev`. And a recursive removal never
> crosses a device boundary.**

Inode identity was always `{dev, ino}` — this document used that pair before Revision 14 — and the rewrite
kept the `ino` half.

### Moving construction outside `dbDir` broke boot on a mounted store root

Revision 24 built the mint under `dirname(dbDir)` to keep it out of the sweepable namespace. If `dbDir` is
itself a mount point — a dedicated volume — the rename into it crosses filesystems, and `EXDEV` is not a
successor result: it is rethrown. A reviewer mounted an empty `dbDir` as tmpfs and the built CLI's
`discard` exited 70 with `EXDEV: cross-device link not permitted`. Coordinator startup takes the same
path, so **every boot refuses on a dedicated volume**. That is this document's subject, introduced by the
previous round's fix.

The same relocation leaks: a process killed after the lock is created and before the first rename leaves
`.coral-store-epoch-construction-<uuid>` under `dirname(dbDir)`, which neither sweep enumerates, so K
deaths leave K permanent unlisted directories.

Both follow from the same move, and the move was answering the wrong question. Round 34 found a reaper
deleting a `.preparing-*` between its `mkdir` and its lock — and **Revision 23 had already stated the rule
that prevents it**: "a mint directory that exists without its `.lock` is a process caught between `mkdir`
and lock creation. That is unobservable, not abandoned." The rule was specified and never implemented, and
round 35 relocated the artifact instead of implementing it.

> **Construction happens inside `dbDir`**, so no rename crosses a device. It happens in a namespace the
> concurrent sweep does not scan, so nothing deletes it mid-build. **And the post-ready sweep reclaims
> that namespace** — where the live coordinator is us and its record says so, which is the evidence every
> other reclamation already uses.

### A read-only SQLite open is a write

`list` classifies each epoch by opening its lock and then its database "read-only". SQLite read-only opens
are not write-free in WAL mode: against an ordinary freshly minted epoch the built CLI added a persistent
`store.db-shm` and a zero-length `store.db-wal`; against a crashed WAL lock it created `.lock-shm`, 32 KiB,
which the guardian reproduced separately.

My Revision 24 narrowing — "must not acquire anything **that can write**" — was therefore wrong in its own
terms, because the read-only open is the write.

> **`list` classifies from `epoch.json` and the filesystem. It does not open the database.**

The sidecar already records the classification at publication, which is what it is for. An epoch whose
`epoch.json` is missing or malformed is already disproven, so there is nothing left to classify by opening.
This removes the mechanism rather than making it safer, and it makes reporting genuinely free of side
effects.

### Carried forward for the next round

The guardian was checking, when it was stopped, whether the post-ready sweep can delete an epoch whose
already-held lock later becomes unproven. That question is unanswered and belongs in the next review.

## Revision 26 — resolve the root once, and reporting means reporting

Round 36's reviewers agreed on six blocking findings. Five are unambiguous and two of those were
introduced by Revision 25 itself. The sixth is a scope question and is recorded below unresolved.

### A symlinked store root silently abandons every epoch

`observeContainedDirectory` compares a child's device against `lstat(dbDir).dev`, and for a symlinked
`dbDir` that is the device holding the **symlink inode**, not the directory it names. Construction follows
the symlink and publishes successfully inside the target; the next boot then proves nothing, finds no
current epoch, and mints another. Both reviewers reproduced it with a store root symlinked onto another
volume: after a successful `discard`, `list` called the fresh epoch `garbage`, and every subsequent start
published a successor instead of reopening its data.

This does not refuse to boot. It **silently starts from an empty store every time**, which is worse,
because nothing reports it. And putting the store on another volume by symlink is an ordinary thing to do.

> **Resolve the store root once, and prove every child against the resolved root's identity.**

Comparing against an unresolved path was the mistake; `lstat` on the root is the one place the design
must follow the link.

### `list` was fixed and the other two reporting paths were not

Revision 25 removed SQLite from `store-reset list` and stopped there. `store-reset report` runs its
diagnostic child directly against the epoch database, and `backend recovery-quarantine list` opens the
store twice — to classify and to query. Measured against the built commands: on a canonical epoch both
added a persistent 32 KiB `store.db-shm` and a zero-length `store.db-wal`; on a crashed-WAL lock `report`
grew `.lock` from 4 KiB to 8 KiB and deleted `.lock-wal`. **Reporting on evidence rewrote the evidence.**

Every reporting surface is byte-identical around the live namespace, proved by snapshot rather than by
intent, and the documented read-only contract covers all three.

### The proof is incomplete where it is reused

`provenStoreEpochAtPath` proves the directory and `store.db`; the read-lock path adds `.lock`; **neither
proves `epoch.json`**, which epoch discovery requires. So `openWritableStoreDbNoReset` accepts an epoch the
canonical selector calls garbage. With malformed metadata, `list` correctly said `garbage/malformed` while
the built smoke opener and `recovery-quarantine list` both opened it and exited 0 — and the generated
hook, which does validate metadata, disagreed with all of them.

The material case is not the CLI: **expansion installation uses that writable opener**, so it can commit
catalog changes into an epoch the next boot replaces. One proof, used by every opener, or the openers
disagree — which is §7 with a data-loss consequence.

### The classification column describes the wrong epoch

Revision 25 made `list` read its classification from `epoch.json`, on my claim that the sidecar "records
the classification at publication". It does not. It records **why the predecessor was superseded**. Both
reviewers reproduced the result: a freshly initialised, valid, current epoch rendered as
`unavailable | operator-discard`, and a replacement for a corrupt store rendered as
`corrupt-or-unsupported | 0.10.9` — the previous store's classification and the previous store's version,
under a column headed `Classification`.

Nothing destructive consumes it, so this is operator-facing provenance rather than a safety defect, and it
is still a lie. The field says what it is — the reason this epoch was published, and the superseded
store's version — or it is derived honestly at publication time from the build's own facts.

### `sameDevice` is a one-line exported helper

It hides `left === right` and exists for its own test. §9. Inline it and test the proof's behaviour
against real filesystem identities instead.

### Unresolved: same-device bind mounts

Both reviewers reproduced a bind mount whose source shares the store's device passing every part of the
proof — kind, `nlink`, `dev`, lexical containment — after which the built smoke opener initialised the
external file to 45 schema objects. Closing it needs mount identity, which on Linux means `statx`
`STATX_MNT_ID` and has no portable equivalent.

This is the fourth alias class in four rounds — symlink, hard link, cross-device mount, same-device mount
— and each was found because the brief asked for the next one. That is a reason to ask where the boundary
is rather than to keep adding axes. Revision 17 placed a same-user process that actively races the
coordinator out of scope, because it can already replace the plugin bundle; someone with mount privileges
is at least as capable. The innocent configurations — a symlinked root, a dedicated volume — are in scope
and are fixed above.

**The owner has not ruled on this one, and it is not decided here.**

## Revision 27 — the promise that was not mine to make

The owner, on being shown the same-device bind-mount finding: _"what were we even defending, for this
whole review loop? Are you talking about someone mounting over `~/.coral`? I never once imagined defending
that."_

That is the correct reading, and four review rounds went into a boundary nobody asked for.

### Where it came from

Revision 21 said: **"this build never opens it, never locks it, and never deletes it."** I wrote that to
protect a rolled-back `v0.10.9`'s live store. Reviewers then did what that sentence invites — looked for
any path that could still reach the flat store — and found four, in order: a symlinked `epoch-N`, a
hard-linked `store.db`, a cross-device bind mount, a same-device bind mount.

**Every one of them requires someone to construct an alias by hand inside `~/.coral/gen2/data/store/`**,
pointing a new epoch's address at the old store, and then to start Coral. Nobody does that. The data it
would protect is the store the owner has called worthless three times. And each was found because the
brief I wrote asked for the next one.

### What the promise should have said

> **The ordinary boot path does not open the previous generation's flat store.**

That is the claim worth having, and it was worth the round that produced it: round 33 found
`inspectGenerationReadiness` classifying the legacy store during a normal start, which opened SQLite and
created `store.db-shm` on a crashed WAL tree — **no operator action, no alias, just booting.** Revision 21's
stronger sentence bought nothing beyond that and cost four rounds.

Revision 17 already placed a same-user process that races the coordinator out of scope, on the grounds
that it can replace the plugin bundle outright. That scope now says so explicitly for the filesystem too:

> **Aliases constructed by hand inside the Coral data directory — symlinks, hard links, bind mounts —
> are out of scope, for the same reason. Someone who can create them can replace the binary that reads
> them.**

### What stays, and what stops

The `nlink` and `dev` checks that landed in Revisions 24 and 25 stay: they are cheap, they are tested, and
round 37 is repairing the one real bug the `dev` check caused — a symlinked store root proving children
against the symlink's own device. **They are not a boundary and must not be extended.** No mount identity,
no `statx`, no fifth axis. A future reader finding them should not conclude that anything here is
tamper-resistant, because it is not and is not trying to be.

Review briefs stop asking for the next alias class. What they ask for instead is what the rest of this
document has always been about: states that arise with **no operator action** — a crash, a power loss, a
rolled-back build, a full disk, a store on another volume, an ordinary command run twice.

### Why this is in the record rather than in a commit message

Four rounds of reviewer time, three of my design revisions, and a chunk of the owner's patience went into
defending something the owner never imagined defending. The mechanism that produced it is the one this
document has already named twice: **I write the briefs, so a premise I invent becomes a given that
thirty-five rounds of review will elaborate rather than question.** Revision 21's promise is the third
instance, after the retention rules the owner had to cut twice.

The check is not more review. It is asking, before writing a boundary into a brief, who is on the other
side of it.

## Revision 28 — carry the root you resolved

Round 37's reviewers took the re-scoped brief exactly as written — both stated they treated no
hand-constructed alias as a finding — and then found four defects in states that arise with no operator
action. Two of the four were introduced by Revision 26.

### The resolved root is computed and then discarded

Revision 26 resolves the store root before proving anything under it, and then every consumer re-derives
the path it actually uses. Three manifestations, all reproduced:

- **The generated hook refuses its own discovery's answer.** `resolveCurrentStoreDbPath` resolves the root
  and returns a path beneath the real target; `storeEpochForDbPath` then compares that path against
  `resolve(dbDir)`, which keeps the symlink's spelling, derives `epoch === null`, and rejects it.
  `pre-compact` composes the two directly, so under a symlinked root it discovers a valid epoch and then
  declines to open it, failing open with no snapshot. This is deterministic, needs no race, and arrived in
  Revision 26.
- **Settlement can lock one store and open another.** `tryOpenCurrentEpoch` discards the resolved root and
  rebuilds from `runtime.paths.coral.store.dbDir`, so if the root's target changes after selection the
  proof and lease land on the new target while SQLite is opened on the old path — a live writer whose
  decisive lease and holder record describe a different store, and whose own epoch stays exclusively
  acquirable by the reaper.
- **The writable and read-only openers** prove the resolved path and then hand SQLite the unresolved one.

> **The resolved root is part of the capability.** It is carried through proof, lease acquisition, opening
> and holder publication, and never recomputed from configuration.

This is Revision 18's sentence at a different layer — _carry the epoch you opened_ — and it is the third
time this branch has been bitten by re-deriving a value it had already decided, after the epoch itself and
the commit adapter. The rule generalises: **a decision that has been made is carried, not recomputed; if
two places can compute it, they will eventually disagree.**

### An empty recovery quarantine became an internal error

`resolveCurrentStorePath` maps an absent root to a passive candidate, and `listRecoveryQuarantineLocal`
then demands a proven epoch and throws a raw `Error`. Its return type admits only an array of entries, so
a refusal has nowhere to go. With an absent or empty store root the installed command now exits 70 with
`Resolved recovery-quarantine store path is outside the canonical epoch layout. [code=internal]`, where it
used to print `Recovery quarantine is empty.` The same raw path is reached when staging exceeds the
diagnostic byte bound or the proof is unreadable.

Three answers again, in a return type that has room for one: absent, unobservable and over-bound are
dispositions an operator can read, not internal errors.

### Verification cannot see a sidecar that was absent

Private-copy staging skips a missing WAL or SHM **without recording that it was missing**, and
verification then hashes only the names it recorded. A reviewer copied `store.db` while no WAL existed,
let a live writer commit into a newly created WAL immediately afterwards, and `verify()` returned true for
a copy that was already stale. `recovery-quarantine list` can therefore report an empty or incomplete list
while claiming the inspection succeeded.

Absence is an observation and is recorded as one. Verification proves what it observed, including that
what was absent stayed absent.

### The report copies have no owner after a crash

Each report stages up to 256 MiB beneath the system temporary directory. Ordinary completion cleans up,
but an unconfirmed child termination returns without attempting cleanup by design, and a kill or power
loss after staging leaves the copy behind. Nothing scans for `coral-store-report-*` afterwards — not the
store sweep, which does not recognise the prefix even when `TMPDIR` is the store root.

K interrupted reports therefore retain roughly K × 256 MiB with no reclamation and no operator-visible
path. Left alone it ends in a full disk, which is the one filesystem failure this document allows to stop
a boot — a reporting command that can eventually prevent startup is the shape this branch exists to
remove. The copies get an owned namespace, an aggregate bound, and a reclaimer that runs where the
existing sweeps already run.

## Revision 29 — a proof is a value, and a concept has one implementation

Round 38's reviewers found six defects, all of them in this branch's own implementation, and none
requiring a new guarantee. They divide cleanly in two.

### The capability is carried as a string, so every boundary re-derives it

Revision 28 made the resolved root part of the capability **inside the opener**, and every boundary above
it still passes a pathname and resolves again:

- **Lifecycle keeps only the ordinal.** Startup routing returns the resolved path; lifecycle retains
  `routing.epoch`, the supervisor exports that ordinal, and the KB daemon rebuilds its database beneath
  the _currently configured_ root. Under a symlinked root that retargets, the coordinator writes
  `oldRoot/epoch-1` while its own daemon writes `newRoot/epoch-1`.
- **The smoke opener proves a path and then hands on a string.** The second resolution no longer
  recognises it as an epoch beneath the configured root, downgrades it to an ordinary file, and opens it
  **without a shared lease or holder record** — after which a sweep that resolved the old root can take
  the supposedly exclusive lock and delete a live writable database.
- The post-ready sweep and `store-reset report` selection re-read the configured root the same way.

> **A proof is a value, not a pathname.** It crosses function, module and **process** boundaries as what
> it is — root, epoch and path together — and no consumer reconstructs it from configuration.

This is the fourth layer at which this branch has been bitten by re-deriving a decision it had already
made: the epoch, the commit adapter, the root inside the opener, and now the root across the process
boundary. The rule has been written down twice and implemented one layer at a time. It is not a layer
problem.

### Two implementations of a concept this branch already solved

- **Report staging exists twice.** Revision 28 gave epoch reports and recovery-quarantine listing an
  owned namespace with a reclaimer; legacy UUID reports still stage into the older random
  `coral-store-reset-*` directory, which no reclaimer recognises. So K interrupted legacy reports retain
  K × 256 MiB — **the exact accumulation Revision 28 claims to have eliminated**, ending in the disk-full
  failure that is the one thing allowed to stop a boot.
- **Ownership is proved by PID again.** The new report namespace records `.owner-<pid>` and tests
  liveness with `kill(pid, 0)`. Revision 19 removed exactly this from holder records, because PID reuse
  makes a dead owner look alive forever; here it makes the reporting surface refuse indefinitely once an
  unrelated process inherits the number. The branch solved this with a lock and then built a second
  answer that does not use it.

§7 is the rule in both cases, and the cost is not theoretical in either.

### Two boundaries that still collapse the third answer

`recovery-quarantine list` gained an `unavailable` disposition and maps only _staging_ failures into it.
A live writer changing the source during inspection makes `verify()` return false, and a staged database
classifying as `newer-incompatible` takes the same path: both throw plain errors, which render as
`[code=internal]` and exit 70. The disposition exists; the two states that need it do not reach it.

And `inspectCurrentStore` decides absence with `existsSync`, which returns false when traversal is
refused. Verified on this host: a root whose parent lacks search permission gives
`{"exists":false,"realpathCode":"EACCES"}`, so `recovery-quarantine list` prints _Recovery quarantine is
empty_ and `store-reset list` can report no epochs, for a store that could not be looked at. **Absence is
`ENOENT`.** Everything else is unobservable, which both list contracts already have room for.

## Revision 30 — a fix applied to a call site is not a fix

Round 39's architect found no blocking defect and one strong one; the guardian found three. Every one of
the four is the **same shape**, and it is the shape the guard history already taught:

> **The previous round fixed one instance of a thing and left the others.**

- `existsSync` was replaced with an `ENOENT` test in `inspectCurrentStore` and **not** in
  `resolveCurrentStore`. So an unreadable root still reads as absent, and its consumers produce credible
  false output: the CLI read store silently opens an **in-memory** database, and expansion catalog reads
  turn `store_not_initialized` into bundled defaults. A permission problem becomes an empty answer nobody
  questions.
- `recovery-quarantine list` routed **staging** failure and **post-open source mutation** into its
  `unavailable` disposition, and left the other two sources throwing: a corrupt or torn private copy that
  fails inside `classifyStoreFile` _before_ verification, and a cleanup failure on a read-only or
  unavailable filesystem. Both still render as `[code=internal]` and exit 70.
- The report reclaimer was given one lock and one namespace, and then also deletes the **legacy**
  `coral-store-reset-*` directories — which a rolled-back `main` process creates directly, without taking
  that lock. A current-build report can therefore delete a live old-build report's evidence while it is
  being written. Introduced by the round that consolidated the reclaimer.
- The report namespace is scoped by the system temporary directory, and its reclaimer assumes every
  matching entry is its own. On an ordinary multi-user host sharing `/tmp`, a crashed report from one user
  leaves a `0700` directory a second user can neither remove nor reuse, and reporting stays unavailable
  until the first user or root intervenes.

Four rounds running, the correction has been applied where the reviewer pointed rather than to the
concept. The remedy is the one this document reached for the structural guard and then failed to apply to
its own fixes: **derive the set, do not enumerate it.** When a rule changes — absence is `ENOENT`,
uncertainty is a disposition, deletion requires ownership — the change is made once, where the concept
lives, and the call sites follow because they cannot do otherwise.

Concretely:

- **Absence is `ENOENT`, in one observation used by every resolver.** Not two functions that each decide
  what absence means.
- **A reporting command's uncertainty is one disposition**, produced by one wrapper around everything that
  can fail between staging and rendering — not routed source by source as each is discovered.
- **Deletion requires ownership of the namespace being deleted.** The reclaimer either owns the legacy
  namespace — which means old builds took the lock, and they did not — or it does not delete it. A
  namespace nobody can prove ownership of is left alone and reported, which is what `list` is for.
- **The staging root is per-user**, because the ownership proof is per-user and `tmpdir()` is not.

### One correction to the brief, from the reviewer

My round 39 brief carried a stale sentence saying epoch 0 remains releasable. Revision 21 removed the flat
store from the epoch space and deleted `release 0`; the documentation agrees that only positive epochs are
addressable. The reviewer was right not to report the CLI's rejection of `0` as a defect, and the stale
text is mine to stop copying forward.

## Revision 31 — the subsystem that is now producing the defects

Round 40's reviewers confirmed that Revision 30 reached what it claimed — seven direct callers of the new
observation, no store-resolution `existsSync` left under `src/store` — and then found four more defects.
Three are worth fixing as stated. The fourth observation is about where they keep coming from.

### The four findings

**Absence is `ENOENT` was applied to the observation and not to the resolution.** `realpath` or `readdir`
returning `ENOENT` _after_ the configured root was observed present is still read as an empty store, in
five sites in the epoch resolvers and in the generated hook. A symlinked root whose target disappears
mid-resolution therefore makes `store-reset list` print no epochs, `report <known-epoch>` answer
not-found, and `pre-compact` claim there are no relevant jobs. The rule was right; it stopped one call
short. Again.

**The direct CLI reader still re-derives the store.** `openReadCoralStore` reduces the resolution to a
pathname through a one-line helper that discards the resolved root and epoch, checks that pathname without
a lease, and then calls the read-only opener, which resolves again. Between the check and the open, a
sweep can remove the selected epoch while a newer one exists — and the command returns an **in-memory**
store with a "no store" note. §9's prohibition on one-line helpers that hide a value names this exact
failure, and the helper is the failure.

**A detached diagnostic child's private copy can be deleted underneath it.** On
`termination_unconfirmed` the supervisor unrefs a possibly-live child and the parent CLI retains the
report lock only in process-local memory; when the short-lived parent exits, the lock is released while
the child may still hold `store.db` open, and the next report reclaims the active namespace. This is
branch-introduced: `main` left the copy behind but had no reclaimer to race.

**Epoch reports render raw errors and absolute paths.** Metadata observation and replacement
classification preserve `Error.message`, and the renderer emits the cause directly or the whole stored
`epoch.json` containing it — contradicting the documented path-free, exception-free report contract.

### Where these are coming from

Five rounds of findings now concentrate in one place: the **private-copy reporting subsystem**. Its
history is staging duplicated in two namespaces, ownership proved by PID, cross-user collision on a shared
`/tmp`, a reclaimer deleting what it did not own, a detached child's copy deleted underneath it, two
disposition gaps, and raw errors in its output. It stands at roughly +355 lines net and has been the
largest single source of defects since Revision 25.

It exists to satisfy a guarantee I introduced in Revision 25: **reporting does not open the store.** The
defect behind that was real and measured — a SQLite open with `readOnly: true` writes `-shm` and a
zero-length `-wal` in WAL mode, so a nominally read-only command altered every epoch it reported on. What
is not obvious in hindsight is that _copying the database_ was the right answer to it.

`list` already needs no copy: it classifies from `epoch.json`, which records the publication reason at
publication time. That leaves two openers — `report <epoch>`, an operator-invoked diagnostic, and
`recovery-quarantine list`. Both inspect SQLite contents, and both could instead be **restricted to an
epoch nothing is writing**: a preserved or garbage epoch is never opened by the coordinator, so a plain
read-only open of one mutates nothing anybody depends on, and no copy, staging root, lock, reclaimer,
ownership proof or per-user namespace is needed.

The cost is that deep inspection of the **current** epoch stops being offered. What it buys is the
deletion of the subsystem that has produced most of this branch's recent defects.

**This is recorded as a proposal, not a decision.** It is a reduction in what the tool offers, which is
the owner's call — and the owner has already ruled once that the elaborate answer was not worth it.

## Revision 32 — delete the machinery; the operator has sqlite3

The owner, on the proposal in Revision 31: _"Delete. This looks like far too much machinery got built. If
someone needs it, they can just open the store with sqlite and look, can't they?"_

They can, and that settles it more cleanly than the proposal did.

### What the machinery was for

The diagnostic child's entire job is one statement: `PRAGMA quick_check(1)`. Around that pragma this
branch built 694 lines — bounded private copies, a staging root, a report lock, a reclaimer, per-user
namespaces, ownership proofs, child-process supervision with SIGTERM/SIGKILL escalation and an
unconfirmed-termination disposition, holder records, and byte-identity tests for all of it. It has been
the largest single source of defects since Revision 25 and produced findings in five consecutive rounds.

An operator who wants `quick_check` can run it. Coral's job is to tell them where the database is.

> **`report <epoch>` reports what it can observe without opening the database: the filesystem facts, the
> `epoch.json` provenance, and the path.** For SQLite internals it names the command to run.

`src/store/reset-incident-diagnostic.ts` and `src/infra/store-report-temp-root.ts` go, and with them the
private copies, the staging root, the report lock, the reclaimer, the per-user namespace, the child
supervision, `MAX_SQLITE_DIAGNOSTIC_BYTES`, and every disposition invented to describe their failures.
The round-40 finding about a detached child's copy being deleted underneath it goes with the child.

### And reading the current store was never the problem

`recovery-quarantine list` is not a diagnostic. It reads quarantine rows — a real product read of the
live store, which the read-only port, the CLI reader and the KB query all perform routinely under a shared
lease. It does that too, with no copy.

Revision 25's measurement stands and was worth having: a SQLite open with `readOnly: true` writes `-shm`
and a zero-length `-wal` in WAL mode. What it actually condemned was narrower than I concluded:

- **opening the previous generation's flat store**, which this build now never does, and
- **opening an epoch we had promised not to alter** — which we now also never do, because `report` does
  not open and `list` classifies from `epoch.json`.

Ordinary reads of the **current** epoch, under its shared lease, were never in that set. I generalised a
measured fact into a rule broader than the fact, and then built a subsystem to satisfy the rule.

### The rest of round 40

Three findings stand on their own and are fixed alongside the deletion: `ENOENT` means absent through the
**whole** resolution and not only its first observation; the direct CLI reader carries the resolved
capability instead of reducing it to a pathname and resolving again, so it can no longer return an
in-memory store while a newer epoch exists; and operator output carries no raw exception text or absolute
paths — much of which leaves with the diagnostic renderer.

## Revision 33 — what the deletion took with it, and two crash cuts

Round 41's architect found **no blocking defect** and confirmed the deletion coherent: reporting opens no
database, the resolved-root/proof/lease model is consistent, retention is ordinal, and no automatic path
renames or unlinks a database a live reader or writer holds. The guardian found three contract defects and
said the same thing in its verdict — *"not evidence that the epoch publication or boot-safety design is
unsound."*

### The deletion took a fact with it

`store-reset discard` used to record `operator-discard` as the successor's provenance. That fixed value
went out with the unsafe raw causes, so an ordinary successful discard of a **healthy** epoch now mints
its successor with `{ kind: 'unavailable' }`, persists it, and prints *Publication reason: unavailable*.
The reason was known exactly — an operator asked for it — and the field now says the opposite of known.

A deletion removes what the thing did **and** what it happened to carry. The carried fact needs putting
back on its own terms: an operator discard is its own publication reason, not an absence of one.

### Two wrappers and a renderer that stop short

`recovery-quarantine list` converts proof and open failures into `unavailable`, and its catch **ends
before the queries run**. A proven epoch can have intact format metadata and a corrupt
`recovery_quarantine` B-tree after a power failure; classification accepts the database, the query then
throws, and the raw SQLite exception reaches the generic envelope and exits 70. The wrapper covers the
opening and not the reading — the same shape as Revision 30's four partial applications, one round later.

And a successful discard returns and prints the absolute store path, against the contract this document
states. The path-free rule was applied to the report renderer and not to the command beside it.

### Two crash cuts leave residue nothing can reclaim

`createSharedFileLockSync` creates the construction directory and then its lock; a kill between the two
leaves an empty `.coral-store-epoch-construction-<uuid>` that the sweep sees, classifies `unobservable`
because it has no `.lock`, and keeps forever. And the durable writer creates `<holder>.json.tmp`, syncs,
then renames; a kill between the sync and the rename leaves `.epoch-holder-<uuid>.json.tmp`, which holder
cleanup ignores because it accepts only `.json`, and which the residue grammar has no arm for.

Neither is large, and K crashes make root cardinality unbounded, which ends where every unbounded thing in
this document ends.

The architect's warning is the load-bearing part of the fix: **do not simply delete a lockless
construction directory after observing it**, because `.lock` can appear between the observation and the
deletion. The pre-lock state needs a bounded, ownership-proven form — or the lock is created first, at a
name that only becomes the construction directory once it exists.

### One inaccuracy in this record

It names the KB daemon's capability variable `CORAL_KB_DAEMON_STORE`. The supervisor writes, and the
daemon reads, `CORAL_KB_DAEMON_STORE`. Production is coherent; the record is wrong.

## Scope, ruled by the owner

**Fix existing defects and defects introduced by this branch's own implementation. Nothing else.** A
reviewer recommendation that amounts to a new guarantee, a new defence, or a new mechanism is recorded in
`docs/todo/` and left there, however sound it is.

This follows Revision 27, where four review rounds went into a boundary the owner had never imagined
defending. The failure mode is not that reviewers propose too much — they are asked to find everything —
it is that I was accepting proposals as work instead of sorting them. The sort is: _does this state arise
from a defect that exists, or from one this branch introduced?_ If neither, it is a todo entry.

Applies to every brief from round 39 onward, and to the remainder of round 38.

## Invariants to add

Two static facts, with no call-graph allowlist beneath them: the only rename whose destination matches
`epoch-<N>` has a `.mint-` source, and the only deletion of an `epoch-` path is inside `sweepStoreEpochs`.
The sweep predicate itself is property-tested over integer pairs.

## Blast radius

`src/store/epoch.ts` becomes the single owner of layout, discovery, publication, metadata, sweep, list,
discard, and release deletion. `backend-store-reset.ts`, `reset-retention.ts`,
`reset-active-evidence.ts`, and `settlement-authority.ts` are deleted. Runtime paths retain only `dbDir`.
The coordinator settles the active positive epoch before opening consumers, and passes that selected epoch
to the KB daemon in `CORAL_KB_DAEMON_STORE`; the daemon opens that exact epoch rather than selecting
again.

The reset test matrix is reduced to dimensions the epoch design still has: concurrent publication,
mint sweep, adversarial epoch chains, seeded process-death cuts, rollback visibility of the untouched flat
store, and sweep failure. Tests for staging, parking, copy/hash selection, retention rotation, resume
classification, and settlement lease revocation are deleted with the machinery they described.

The operator surface addresses epochs by number: `list` classifies each epoch read-only, `report <K>`
reports observable filesystem facts and allowlisted `epoch.json` provenance without opening SQLite and
names the command an operator can run, `release <K>` removes a non-current epoch through the sweep owner,
and `discard` publishes the next epoch. `backend recovery-quarantine list` opens the current epoch under a
shared lease and reads its rows directly. A UUID report remains only as compatibility for rows found by the
bounded legacy quarantine reader; no new legacy manifest is written. The private-copy staging root, report
lock, reclaimer, diagnostic child and its signal supervision, copy-size/output/termination limits, and their
dispositions are deleted.

Gates: `format:check`, `lint`, `typecheck:tests`, `knip`, `build`, `npm test`, `test:integration`,
`test:store-reset:integration`, `verify:store-reset-build`, `test:e2e:build`, `test:e2e:lifecycle`.
`verify:store-reset-build` verifies bundle identity probes rather than the quarantine protocol and should
be unaffected.

## Rollback behaviour

A newer build publishes `epoch-1/` or later beside the previous generation's flat files. A rolled-back v0.10.9-shaped
reader does not enumerate the store directory: it opens `<dbDir>/store.db` directly and sees its own data
unchanged. It can boot and continue writing the flat store. A later new build still chooses the highest
positive epoch and never observes the flat name as an epoch. Automatic sweep and explicit `release` share
that positive-only address space, so neither can remove, lock, or prove the flat database.

## Adjacent findings, tracked separately

- **There is no store migration path, and it is the real defect behind all of this.** See
  [`no-store-migration-path.md`](no-store-migration-path.md).
- The six `store_reset_interrupted_*` boot refusals and their resume state were removed with the staging
  protocol.
- `retainActiveStoreTransition` now writes beneath the coordination root. Its former quarantine byte bound
  and `store_reset_quarantine_failed` boot path are gone.
- `retained-active-store-transitions/` has **no operator surface at all**, deliberately, and its count is
  unbounded in principle. Bounded in practice today at 8 KB, but a refusal there is not visible as
  durable status.
- **`retained` means three different things** across this file set — the V2 schema still readable,
  evidence kept on disk, and a provider-host hold state. This design says `preserved` for the slot rather
  than reuse the house word.
- `tests/invariants/store-reset-discipline.test.ts` now asserts the two publication/deletion facts directly
  instead of maintaining a list of protected functions.

## How the design was reached

Three review rounds, each of which found a real defect in the one before it, and each defect was the same
mistake in different clothing: a bound that was correct about what it measured, promoted into a veto on
booting. The size budget. Then two refusals invented to enforce retention. Then, nearly, the maintenance
lease itself.

Then a fourth round that no amount of reviewing would have produced. The settled design was handed to an
implementation delegate with explicit authority to refuse, and it refused before making a single edit,
with six findings that all held. Two were fatal. The field this document had called its highest-value
output was **inverted** — it would have named the build that _rejected_ a store as the build that can read
it — and the copy arm's ordinary crash state was classified as tampering, which would have shipped a new
unbootable coordinator inside the change built to remove one. Neither was findable by reading the design;
both were findable in minutes by trying to write it. **Authorize the implementer to refuse, and treat a
refusal with evidence as the deliverable.**

Two process notes from the earlier rounds still generalize. The hole in the writer analysis was findable
in one step from `tests/invariants/writable-db-coordinator-only.test.ts`, whose allowlist enumerates
exactly that hazard class and whose KB-daemon entry documents its own history of evading a static scan; a
grep was reached for instead, and it missed the second writer because it filtered on one callee name.
**An invariant test that enumerates a hazard class is a better oracle than a grep, and this repository
already maintained one.** And the first draft's central authority — operator acknowledgement as the gate
on deletion — did not survive asking who reads the error message. In a product whose operator is a
language model, a refusal does not buy the deliberation it was meant to buy; it buys one extra step
before the same outcome, with a dead daemon in between.
