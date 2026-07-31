# Store Generation Boundary

## Status

Planned. Not implemented. Supersedes `store-format-path-isolation.md` (deleted),
which keyed the store directory per store-format fingerprint. That approach
fragmented history across formats and taxed every schema edit; this one does not.

Root causes below are confirmed by reading and by forensic evidence from a real
machine.

## Problem

Coral destroys the user's store when two Coral generations share one machine.

Observed 2026-07-31, twice, sixteen minutes apart, in
`~/.coral/data/store/store-reset-quarantine/`:

1. Coral 0.10.3 quarantined a **72,806,400-byte `store.db`** whose SQLite
   integrity check reported `ok`, plus a 4.1 MB WAL. Manifest:
   `schemaVersion: 2`, `reason: "missing"`, `storedFingerprint: null`.
2. An older generation then quarantined the 4,096-byte store 0.10.3 had just
   created. Manifest: `schemaVersion: 1`, `reason: "retired"`,
   `storedVersion: 0`, `expectedVersion: -710642126`.

### Mutual and deterministic

The generations discriminate compatibility differently:

- 0.9.x keys freshness on `PRAGMA user_version` (a signed 32-bit schema hash).
  Current code never sets `user_version`, so a current store reads back `0` and
  0.9.x classifies it `retired`.
- Current code keys on the `meta.store_format_fingerprint` row. A 0.9.x store has
  user tables and no such row, so `classifyStoreFormat` returns `missing`.

Each classifies the other's store as resettable, quarantines it, and continues.

### Destruction is forced by the discriminator, not chosen

The current discriminator is a sha256 over the DDL plus every persisted codec
contract. **A hash cannot express ordering.** It can only answer "same or
different", so the only available response to "different" is to destroy. Nothing
in the design intends data loss; the choice of discriminator leaves no other move.

The hash is also over-sensitive. `canonicalDdl`
(`src/store/format-fingerprint.ts:445-447`) normalizes line endings and trailing
whitespace only — **comments are hashed**. Editing the `-- Rows: …` comment above
the `meta` table changes the fingerprint and resets every store, for zero
semantic difference.

### Why classification changes alone cannot fix it

`~/.claude/plugins/cache/coral/coral/` retains every installed version
(`0.9.14`, `0.9.15`, `0.9.16`, `0.10.3` on the affected machine) and all remain
executable. Claude Code fixes the plugin version onto a session at session start,
so a long-lived session keeps invoking an older version indefinitely. Those
bundles are on disk and will keep quarantining `data/store/store.db` forever.

**A defense that requires the destroyer's cooperation cannot work against an
already-shipped destroyer.** Only moving the file out of their reach works,
because it needs no cooperation.

### Handoff is not required

The 22:51 manifest records `"handoff": {"acquiredViaHandoff": false}` — the
coordinator bound its socket without evicting a live incumbent. The older daemon
had already idle-exited and left its store behind; the next generation destroyed
it on a clean boot. **Sequential coexistence suffices to destroy.** Re-keying the
coordinator socket would have prevented neither incident.

### The general defect

| Exclusive resource | Path key today | Identity the compatibility check compares | Consequence        |
| ------------------ | -------------- | ----------------------------------------- | ------------------ |
| `store.db`         | flavor         | store-format fingerprint                  | mutual destruction |
| coordinator socket | flavor         | version + bundleHash + flavor + namespace | mutual eviction    |

`isCompatibleHealth` (`src/transport/ipc/ensure.ts:285-292`) compares four axes;
`coordinatorPaths(flavor)` keys the socket it arbitrates on one.

**Rule this plan establishes:** every axis a compatibility check compares must
appear in the path of the exclusive resource that check arbitrates — or the check
must be able to express direction, so it can migrate or refuse instead of destroy.

## Design

Four parts. Part 1 defends against versions already shipped; parts 2-4 stop
future versions from ever needing that defense.

### 1. One new state-tree generation, from this version on

The machine-local state tree gains a generation segment. Current and all future
versions read and write `<stateRoot>/data[-dev]/gen2/…`; already-shipped versions
compute `<stateRoot>/data[-dev]/…` and never discover it.

This is a one-time boundary, not a per-format key, so all future versions share
one store and history never fragments.

### 2. Fingerprint answers "compatible?", product version answers "which way?"

The product version is strictly increasing and never retagged, which makes it a
valid ordering signal. Keep the fingerprint as the compatibility oracle — exact
detection is its strength — and add the writing product version as the direction
signal:

```
fingerprint equal                      → compatible; proceed regardless of version
fingerprint differs, stored version <  → migrate forward (upcast + rebuild projections)
fingerprint differs, stored version >  → refuse with guidance; never destroy
fingerprint differs, version absent    → legacy pre-boundary store; adoption handles it
```

Do **not** introduce a hand-maintained store-format integer. A counter someone
must remember to bump gets forgotten; the product version is already monotonic by
policy and needs no discipline.

The writing version lives in a `meta` row. Rows are data, not DDL, so adding one
does not change the fingerprint — provided the schema comment listing expected
rows is left alone (see the comment sensitivity above).

### 3. Destruction becomes operator-authorized

Automatic destructive reset is removed. `missing`, `mismatch`, and
newer-than-me all refuse and explain. A new explicit command is the only path
that destroys, and it routes through the existing crash-safe quarantine
machinery.

This is what closes the original defect at its root rather than by hiding the
file: the 72 MB loss happened because destruction was automatic and unauthorized.
It also gives the quarantine machinery a correct authorization model instead of
stranding it behind a refusal.

The escape hatch is narrower than it looks:

- **Downgrading to a pre-boundary version** (0.9.x, 0.10.3) needs no hatch. Those
  versions only read the legacy path, so they keep working against their own
  legacy store and never see a refusal. Part 1 solves this case.
- **Downgrading within the post-boundary generation** needs the hatch — and the
  command ships in the same versions that refuse, so it is always present exactly
  where it is needed. Self-consistent.

### 4. Requests carry a comparable version

Nested and cross-version invocations send their version, so a mismatch resolves
by ordering instead of by mutual eviction: the newer participant proceeds and the
older is told to step aside. This replaces coordinator handoff ping-pong for the
cross-version case with a deterministic one-way yield, and gives the Corpus
version floor (below) the same comparison.

## Scope: what moves

The boundary covers **machine-local state coupled to the store**. It does not
cover content the user authored.

| Tree                                        | Moves into `gen2`? | Reason                                                                                           |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `data[-dev]/store`                          | yes                | the proven destruction target                                                                    |
| `data[-dev]/kb` (Orama index, index-state)  | yes                | derived; its freshness cursors live in `store.db`, so it must move with it                       |
| `data[-dev]/engines` (256 MB payloads)      | yes                | its catalog lives in `store.db`; moving both keeps catalog and payload consistent                |
| `data[-dev]/equipment`                      | yes                | rebuildable consumer of the same store                                                           |
| `~/.coral/kb`, `kb-dev` (Corpus)            | **no**             | single authority the user authored; git-backed. Version floor, not isolation                     |
| `~/.coral/projects/*` (analysis/memo/plans) | **no**             | authored content; forking it would fragment the user's writing                                   |
| `~/.coral/exports*` (job artifacts)         | **no**             | addressed by jobId, never enumerated by format; orphaning after a reset is pre-existing behavior |

Moving `engines` by rename is why the catalog/payload question disappears: the
new generation boots with a consistent catalog-and-payload pair. An older version
that later runs finds `data/engines` empty and re-installs its own — correct for
its generation, and paid only if an old version is actually used.

### Partitioned roots must inherit the segment

`~/.coral/by-config/<hash>/data` exists as a `baseDir`-partitioned state root
(689 entries on the affected machine, all currently empty of stores). The
generation segment therefore **must live inside the path composition**, not in a
hardcoded absolute path — otherwise every partitioned root silently keeps the old
layout. `storePaths`, `kbRuntimePaths`, and `enginePaths` all already thread
`opts.baseDir`, so composing the segment there covers all of them.

## Required invariants

1. **No current-or-future version reads or writes the legacy state tree** except
   through one-time adoption. Asserted by a path invariant.
2. **No code path destroys store data without an explicit operator command.**
   Open-time classification may refuse; it may not quarantine.
3. **The DB row is the only classifier.** The `store.db.format` sidecar never
   participates: it has a legitimate different consumer
   (`clients/hooks/pre-compact.mjs:63-97`, a pre-flight for a hook that may not
   import `src/`) and it lies. The affected machine proves it — `store.db.format`
   (22:51) still describes a database the older generation quarantined at 23:07.
4. **The hook's derived paths mirror the path authority.** Hooks cannot import
   `src/` (design philosophy §6), so the duplication is mandated and an invariant
   must assert agreement.
5. **The generation segment is expressed once**, in the composition every state
   family shares.

## Implementation

1. **`src/infra/path/root.ts`** — add
   `stateGenerationRoot(flavor, opts?)` returning
   `join(coralStateRoot(opts?.baseDir), flavor === 'dev' ? 'data-dev' : 'data', STATE_GENERATION)`
   with `STATE_GENERATION = 'gen2'`. This becomes the single canonical home for a
   rule currently duplicated as a `flavor === 'dev' ? 'data-dev/x' : 'data/x'`
   ternary in three files.
2. **`src/infra/path/store.ts`, `kb-runtime.ts`, `engine.ts`, and the equipment
   family** — compose off `stateGenerationRoot` instead of their local ternaries.
   Signatures are unchanged; only the base changes. Filenames, the reset lock, the
   quarantine root, and the sidecar all derive from `dbDir` and move for free —
   **zero literal churn.**
3. **`src/store/format-fingerprint.ts` / `src/store/db.ts`** — add the writing
   product version to the classification result, and replace the binary
   `missing | current | mismatch` response with the four-way decision in Design §2.
   `classifyStoreFormat` gains the stored version; the destroy branch is removed
   from `openStoreDatabase`.
4. **`src/store/backend-store-reset.ts`** — `openOrResetBackendStoreDb` stops
   resetting. It classifies, adopts, migrates, or refuses. The quarantine
   machinery keeps its crash-safe resume path and is invoked only by the new
   command.
5. **New: production projection rebuild.** `applyJournalPragmas` already has a
   `rebuild` mode documented as "test/regression bulk-replay utilities … Production
   never uses this" (`src/store/db.ts:78-79`). Forward migration needs it in
   production: drop and recreate projection tables, replay `events` through
   `composeReducers`, reset consumer cursors. Event-body upcasters already exist.
   Consumers with external side effects (Orama, Corpus) require reindex, not
   replay — data-preserving but not free.
6. **New: explicit reset command.** `coral-cli backend store-reset` is
   inspection-only today; add the authorized destructive operation as a sibling.
   This is the only new user surface the design introduces.
7. **New: `src/store/legacy-store-adoption.ts`** — one-time forward-only
   adoption, called from `openOrResetBackendStoreDb` after the directory lock and
   before incident resume. Guards: (a) runs only when the `gen2` tree has no
   store; (b) renames the four legacy families into `gen2/` only when the legacy
   store classifies `current` or migratable; (c) otherwise touches nothing; (d)
   never reads the legacy path again. Same filesystem, so the 256 MB engines move
   is a rename. Forward-only migration in an honestly-named, deletable module —
   not a compatibility shim.
8. **`clients/hooks/pre-compact.mjs`** — mirror the new base.
9. **`tests/invariants/flavor-path-separation.test.ts`** — extend to assert the
   generation segment appears in every moved family, that the legacy base appears
   nowhere in `src/`, and that the hook's derived path equals the authority's.

## KB: Corpus version floor, not isolation

The Corpus (`~/.coral/kb`) must never fork — forking the user's knowledge is worse
than any downtime — and it does not need to, because it is a git repository
(`auto: kb mutation` commits), so damage by an older version is recoverable. That
recovery path is exactly what the store lacked, and it is why the two trees get
different designs.

KB artifacts already carry `schemaVersion` with **strict equality** validators
(`src/kb/runtime.ts:962`, `src/kb/curate/community/generated-projection-store.ts:241,256`,
`src/kb/corpus/projection-lifecycle.ts:87`). Strict equality is the right shape for
"an older version must not touch newer state" — but the failure mode is unaudited:
if a caller treats a failed validation as _absent, regenerate_, an older version
**downgrades** newer state instead of refusing. That audit is a prerequisite.

Design: one corpus-level version floor (the Corpus is one authority, so a single
marker in `manifest-authority.ts`, not per-artifact), compared with the same
ordering as Design §2 — refuse and name the version to use. Effective from this
version forward, with git as the backstop for the gap.

Consequence to record: KB freshness cursors live in `store.db`
(`consumer_cursors`), so a store reset zeroes them. This already happened — the
affected machine has `index-state.json` at `{contentSeq: 0, metadataSeq: 0}` and a
10.6 KB Orama index against a large corpus, i.e. **KB search is stale and needs a
reindex.** Any future forward migration carries the same reindex cost.

## Deferred: coordinator socket re-key

The same one-axis-key defect applies to the coordinator socket, and the right key
would be `flavor + namespace` (already on `RawCoordinatorHealth`,
`VerifiedBackendInfo`, discovery, `/health`, and every job record; `bundleHash`
would respawn on every local rebuild). Principle 2 survives — it concerns which
component owns which truth, not process count, and prod/dev already run two
coordinators.

**The prerequisite fails, so this plan does not do it.** Investigated:

- **Append is safe** — `src/store/append.ts` reserves `seq` by `MAX(seq)+1..N`
  under `BEGIN IMMEDIATE`, which SQLite serializes across processes.
- **SQL projections look tolerant** — each projection row carries its own
  `last_seq`, and cursor advance is guarded
  `UPDATE consumer_cursors SET cursor = ? WHERE consumer_id = ? AND cursor < ?`,
  so a stale driver cannot rewind.
- **The store lock does not help** — `store.db.reset.lock` is released in
  `openOrResetBackendStoreDb`'s `finally` immediately after open. It guards the
  classify-open window only, not the daemon's lifetime.
- **Blocker: `consumer_cursors` is one global row per `consumer_id` with no owner
  lease.** Two coordinators would both claim e.g. `orama-base`. Beyond duplicated
  work, consumers with external side effects — Orama, and Corpus through the KB
  daemon — would be driven by two processes at once; two coordinators means two KB
  daemon supervisors writing one KB tree.
- `meta.coordinator_id` is written (`schema.sql:215`) and read nowhere in `src/`,
  which reads as a vestige of precisely the missing lease. **Keep it** — it is the
  natural home for that lease, and removing it would change the DDL and reset
  every store for no benefit.

Design §4 (requests carry a comparable version) reduces the ping-pong's cost
without the re-key: a mismatch yields one way instead of evicting both ways.

Independent cheap improvement: when a job lookup misses and the store holds that
job under a different namespace, say so — _"job `<id>` belongs to Coral namespace
`<ns>` (plugin root `<path>`); it is visible to sessions started from that
installation."_ Every job record carries its namespace.

## Accepted trade-off

A release that changes the store format forces a **forward migration**, after
which live sessions pinned to older post-boundary versions are **refused** rather
than served. Today they would be served — destructively. Loud refusal with a
"restart your session" remedy beats silent loss, but this is a deliberate choice,
not a side effect. It argues for changing the format rarely, and for the
comment-insensitivity fix so cosmetic edits never trigger it.

## Test and CI gap

Two e2e lifecycle tests were failing on `main` outside every gate. `npm test` runs
typecheck plus `vitest/default.ts` and `vitest/simulation.ts`;
`.github/workflows/ci.yml` runs `build`, `test`,
`test:store-reset:integration`, `verify:store-reset-build`, and
`test:e2e:store-reset:build` — never `test:e2e:lifecycle`.

`tests/e2e/cli/lifecycle/mutate-via-ipc.test.ts` is repaired (commit `9f120f75`).
Remaining, in order:

1. **Narrow `tests/e2e/lifecycle/flavor-coexistence.test.ts`, rename to namespace
   coexistence.** Its premise is unachievable: it relabels `flavor` in a fixture
   manifest, but flavor is `define`-injected at build time and
   `resolveStrictBundleIdentity` requires `manifest.flavor === embedded.flavor`. It
   also writes a three-field manifest (`parseStrictManifest` rejects it) and copies
   only `coral-backend.cjs` while strict identity hashes all three artifacts. Its
   assertions are almost entirely about **namespace** isolation, which two _prod_
   fixtures at different plugin roots exercise fully; the genuinely flavor-specific
   claims are pure path properties already covered by
   `tests/invariants/flavor-path-separation.test.ts`. Rebuild the fixture in the
   shape of `tests/integration/coordinator/helpers.ts` `createPluginFixture`.
2. **Add the regression test for this defect** — in-process, sub-second, must land
   with the implementation. `describeStoreFormat(ddl, codecs, ddlFragments)` is
   exported and takes fragments, so a test can synthesize a second format from the
   real one plus a throwaway fragment. Assert: an older-version store is migrated
   forward with its events intact; a newer-version store is refused and left
   byte-identical with no quarantine incident; the explicit command is the only
   thing that quarantines.
3. **Wire `test:e2e:lifecycle` into CI** — only after step 1, or CI breaks.

## Verification

```bash
npm run lint
npx tsc --noEmit -p tsconfig.json
npm run typecheck:tests
npm run format:check
npm test
npm run build:dev
npx vitest run --config vitest/e2e-lifecycle.ts
```

Manual adoption check against a disposable `HOME`: populate a legacy
`data/store` + `data/engines` tree, boot, and confirm all four families moved into
`data/gen2/`, no quarantine incident was published, the expansion catalog still
resolves its payloads, and `backend store-reset list` still resolves prior
incidents.

## Acceptance criteria

- No current-or-future version resolves a path under the legacy state tree except
  through adoption, asserted by an invariant.
- Partitioned `baseDir` roots inherit the generation segment.
- An older-format store is migrated forward with its events preserved.
- A newer-format store is refused, left byte-identical, and names the version to
  use.
- No open-time code path quarantines; only the explicit command does.
- Adoption moves store, kb runtime, engines, and equipment together, and the
  expansion catalog still resolves its payloads afterward.
- The Corpus and `projects/` trees are untouched by the boundary.
- The sidecar is still written, still read only by the hook pre-flight and as
  reset evidence, and never classifies.
- `schema.sql` DDL is unchanged, so no existing store is reset by this work.
- `test:e2e:lifecycle` passes and runs in CI.

## Open questions

- **KB strict-equality failure mode** — does a failed `schemaVersion` validation
  error out, or is it treated as absent and regenerated? The Corpus version floor
  depends on the answer. Prerequisite for the KB section.
- Should `canonicalDdl` strip comments so cosmetic edits stop changing the
  fingerprint? Worth doing, but it changes the fingerprint once, so it should ride
  the same release as the boundary.
- `classifyStoreFile` classifies through a read-only handle, then
  `openStoreDatabase` classifies again writable. For a WAL database whose `-shm`
  is absent or unwritable, the read-only open can fail outright rather than
  returning a classification, and that throw is unwrapped at the call site.
  Plausible from SQLite's read-only WAL semantics; untested.
