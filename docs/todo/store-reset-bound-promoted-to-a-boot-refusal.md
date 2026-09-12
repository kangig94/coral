# TODO — a store-reset bound became a boot refusal, three times

**Status**: design settled 2026-09-13 after an implementation attempt refused it and six repairs landed.
This document is the specification.

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
