# TODO — a store-reset bound became a boot refusal, seven times

**Status**: in flight. Six design revisions, five unbiased tier-1 review rounds, and seven distinct
instances of the same defect so far. This document is the specification; read the revisions in order,
because each one records what the previous got wrong.

A coordinator refused to start because the store was too large to *report on*. Recovering it needed a
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

This replaces an earlier sentence — *"every observation selects a mechanism; none selects a refusal; only
a genuine filesystem failure may stop the boot"* — which was the defect rather than the cure. It named
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

| Lease answer | Primitive | Cost |
| --- | --- | --- |
| drained | `link` | zero bytes |
| `writer-live` | `copy`, no budget | 2x disk, one read and one write |
| `writer-unobservable` | `copy`, no budget | same |
| lock timeout — we could not even ask | `copy`, no budget | same |
| `EXDEV` / `EMLINK` / `EPERM` / `EOPNOTSUPP` | `copy`, no budget | same |

The lease's failure is **caught and mapped, never propagated**. That is what makes the invariant below
mechanical rather than aspirational:

| From `acquireGenerationMaintenanceLease` | Disposition |
| --- | --- |
| resolves | `proven` — link |
| `legacy_source_not_quiescent` | `unproven`, `writer-live` — copy |
| `legacy_source_writer_observation_unknown` | `unproven`, `writer-unobservable` — copy |
| a raw admission or maintenance directory-lock timeout | `unproven`, `lock-timeout` — copy |
| anything else | rethrow — a genuine I/O failure, the only thing allowed to stop a boot |

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
recorded *inside* the quarantined store, taken from `classification.storedProductVersion` at publication.
`raiseStoredProductVersion` bumps it on every compatible open, so it names the last build that could open
that store, which is the build to install to read it. `null` is a real third answer: the store carried no
version metadata. Incidents published by builds predating this ledger have no entry and render `unknown`
rather than a guess.

A quarantined store is unreadable by the build that quarantined it by construction, so preserved evidence
is only ever useful to someone who installs the matching older build. A row reading *"1.17 GB, incident
`bdd75824…`"* is actionable by nobody, which is why the field exists.

It is **not** derivable from the manifest, and the obvious projection is inverted: `createIncidentManifest`
writes `build.version` from `authority.version` — the build *performing* the reset, the one that rejected
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
  | { kind: 'preserved'; incident: BackendStoreResetIncident; preservation: PreservationMechanism; retention: PreservedRetention }
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

type DiscardReceipt = { resetAt: string; resetPolicyCause: StoreResetPolicyCause; evidenceBytes: number; deferredTo: string };
```

`errno: 'other'` beside the raw `code` is the third answer for an errno nobody enumerated — carried rather
than flattened. `coherence: 'torn'` is independently evidence that a writer was active. Two facts, two
fields: why linking was not used, and whether the copy is a coherent point-in-time snapshot.

### The resume splits two obligations that were one loop

Finishing the commit is about **staged** evidence. Deleting the active file is about **active** evidence.
Today they are a single loop, which is how a question about the active side became able to block a boot.

```ts
/** Whether the committed evidence is intact. Decisive, and the only producer of a refusal. */
type StagedEvidenceIntegrity =
  | { kind: 'intact' }
  | { kind: 'corrupt' }
  | { kind: 'undeterminable'; cause: string };

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
  publication has. Measure before shipping. The rule is *identity where identity exists, content where it
  does not.*
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
older build, nearly all is not nothing. Discharging a *byte* obligation on *coherence* evidence would be
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
2. **A name** — the active pathname *after* the claim is minted. Present? Same inode? May I unlink?
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
already returned the identity, and the rule is *identity where identity exists, content where it does not*.

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
symlinked root *is* verified, as not ours.

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
enumeration and descriptor open fails the check and refuses the boot, on the arm that exists *because* a
writer is live. The same module already answers the same question correctly elsewhere:
`linkActiveEvidence` compares `dev` and `ino` alone. That inconsistency was the tell.

**`removeActiveEvidence` is the observe-then-act shape the redesign set out to eliminate**, written
inside the module created to eliminate it.

**"Claims throw" is not an extendable category.** It is defined by what the manifest asserts, so an
author reasoning backward from manifest to descriptor to enumerated identity lands a throw on a *source*
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
every inode it describes is owned. The single shared-directory refusal that remains is a *precondition*
stated once at the top of the sequence — enumeration refuses an entry that is not a regular file, before
anything has moved — so no author can generalize from it.

### Removal is a capability: park, inspect, drop or link back

Exclusive namespace ownership is unattainable against the only population that can race: every Coral
actor is already excluded from replacing an inode by the adoption lock, the reset lock and the
maintenance lease, and SQLite never renames over `store.db`. The racing party is foreign, and POSIX
offers no mandatory lock and no conditional unlink. So the answer is a primitive, not a lock.

You cannot inspect-then-act on a name you do not own. You *can* move whatever is at that name into a name
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
*compatible* store carrying a sentinel table, so a run can prove the replacement was classified rather
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
errno to `undeterminable`; that clause was about *observations* and was over-applied to a mutation. An
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
most instructive one yet: the parking helpers `rename` successfully and *then* throw because the parked
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

Enumeration may refuse a non-regular file *before anything has moved* — that is a precondition, stated
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

## Invariants to add

Superseded by Revision 3's own invariant list. The entries that stood here named
`openOrResetBackendStoreDb`, which Revision 3 deletes, so keeping them left the document asserting two
incompatible architectures. The one that survives unchanged is: no `store_reset_*` remediation contains
`store-reset release`, asserted against rendered remediation values rather than textual proximity.

## Blast radius

`src/store/backend-store-reset.ts` carries the largest change; `src/store/reset-retention.ts` is new.
`src/store/reset-incident.ts` gains constants only — **the manifest schema does not change**, and cannot:
`validateManifest` uses `requireExactKeys` at every level and the staging manifest is parsed on the
startup path before any authority check, so one added key means `manifest_invalid_schema` and an
unbootable coordinator for every shipped build. `files` must also be non-empty, so a manifest-only
incident is not representable.

Also touched: `reset-incident-reader.ts` (list entries gain retention and `storedProductVersion`, read
from the ledger rather than the manifest),
`active-store-selection-coordination.ts` (supply the recovery lease on the startup arm, gated on a reset
being needed), `startup-store-routing.ts` (wire the lease in), `operator-store-reset.ts`,
`cli/commands/backend.ts`, `cli/store-reset.ts`, `cli/format/store-reset.ts`, `cli/classify.ts`,
`runtime/errors.ts`. `infra/port-types.ts` and `runtime/real.ts` need nothing.

Docs describing the copy-then-unlink commit and the incident model need the link primitive, the slot, and
the release command: `docs/architecture.md`, `docs/configuration.md`, `docs/design-rationale.md`.

Tests carry the most volume. `tests/integration/store/open-or-reset.test.ts` is the big one. Its "retains
the verified copy when active evidence mutates during its final removal" case **loses its premise** under
`link` — active and staged are one file, so independent mutation is impossible; replace it with an
unmatched-inode case rather than deleting it. Its "fails closed when active evidence is replaced between
path stat and descriptor open" case must stay green **unchanged**: it targets the before-copy check, which
does not soften. Startup now takes the maintenance lease, so every reset case needs the coordination root
present.

Four new cases, each one a state where the pre-repair design produced an unbootable coordinator:

- **copy arm, crash after the manifest write, resume finishes the commit and boots.** This is the highest
  risk in the whole change and the highest-value test in it — the only path where a crash, a concurrent
  writer and a shipped older reader all meet.
- link when the maintenance lease reports drained, copy when a writer lease is held.
- a torn copy publishes a manifest the reader verifies as `match`.
- adoption of a single orphaned committed incident on a vacant slot.

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
- **The six `store_reset_interrupted_*` codes are boot refusals that this document's own rule condemns.**
  `resumeAutomaticBackendStoreResetIncident` turns every `InterruptedStoreResetRefusal` into a documented
  setup error on the startup path, so each is a bound or a check correct about what it measured and
  promoted into a veto on booting. This design leaves all six exactly as they are and is scoped so as not
  to add a seventh. The likely fix — quarantine the unverifiable staging directory under a non-UUID name,
  record it in the ledger, continue to classification — gives each anomaly a durable identity and an exit
  through `release` instead of a dead daemon. It is the next instance of the pattern and needs its own
  review.
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

Then a fourth round that no amount of reviewing would have produced. The settled design was handed to an
implementation delegate with explicit authority to refuse, and it refused before making a single edit,
with six findings that all held. Two were fatal. The field this document had called its highest-value
output was **inverted** — it would have named the build that *rejected* a store as the build that can read
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
