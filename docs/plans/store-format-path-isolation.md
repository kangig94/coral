# Store Format Path Isolation

## Status

Planned. Not implemented. Root causes confirmed by reading and by forensic
evidence from a real machine; the projection-concurrency gate below was resolved
by reading and closes the coordinator re-key question for now.

## Problem

Coral destroys the user's store when two Coral generations share one machine.

Observed on 2026-07-31, twice, sixteen minutes apart, in
`~/.coral/data/store/store-reset-quarantine/`:

1. Coral 0.10.3 quarantined a **72,806,400-byte `store.db`** whose SQLite
   integrity check reported `ok`, plus a 4.1 MB WAL. Manifest: `schemaVersion: 2`,
   `reason: "missing"`, `storedFingerprint: null`.
2. An older generation then quarantined the 4,096-byte store 0.10.3 had just
   created. Manifest: `schemaVersion: 1`, `reason: "retired"`,
   `storedVersion: 0`, `expectedVersion: -710642126`.

### Why it is mutual and deterministic

The two generations discriminate store compatibility differently:

- 0.9.x keys freshness on `PRAGMA user_version` (a signed 32-bit schema hash).
  Current code never sets `user_version`, so a current store reads back `0` and
  0.9.x classifies it `retired`.
- Current code keys on the `meta.store_format_fingerprint` row. A 0.9.x store has
  user tables and no such row, so `classifyStoreFormat` returns `missing`.

Each generation therefore classifies the other's store as resettable. Both
quarantine and continue.

### Why classification changes cannot fix it

`~/.claude/plugins/cache/coral/coral/` retains every installed version
(`0.9.14`, `0.9.15`, `0.9.16`, `0.10.3` on the affected machine) and all remain
executable. Claude Code fixes the plugin version onto a session at session start,
so a long-lived session keeps invoking an older version indefinitely. Those
bundles are already on disk and will keep quarantining any
`data/store/store.db` whose `user_version` is not theirs, forever. No change to
current classification logic can restrain an already-shipped destroyer.

The only defense is to stop sharing the path.

### Handoff is not required

The 22:51 incident manifest records `"handoff": {"acquiredViaHandoff": false}` —
the coordinator bound its socket without evicting a live incumbent. The older
daemon had already idle-exited and left its store behind; the next generation
destroyed it on a clean boot. **Sequential coexistence is sufficient to
destroy.** Re-keying the coordinator socket would have prevented neither
incident.

### The general defect

| Exclusive resource | Path key today | Identity the compatibility check compares | Consequence        |
| ------------------ | -------------- | ----------------------------------------- | ------------------ |
| `store.db`         | flavor         | store-format fingerprint                  | mutual destruction |
| coordinator socket | flavor         | version + bundleHash + flavor + namespace | mutual eviction    |

`isCompatibleHealth` (`src/transport/ipc/ensure.ts:285-292`) compares four axes;
`coordinatorPaths(flavor)` keys the socket it arbitrates on one.
`openStoreDatabase` compares the store-format fingerprint; `storePaths(flavor)`
keys the file it arbitrates on flavor alone.

**Rule this plan establishes:** every axis a compatibility check compares must
appear in the path of the exclusive resource that check arbitrates.

## Goals and non-goals

Goals:

- make a store file reachable only by builds that can read it;
- adopt an existing current-format store into the new layout exactly once;
- keep the crash-safe quarantine machinery live and make its precondition true;
- tell the operator where earlier history went; and
- close the CI gap that let two e2e lifecycle tests rot undetected.

Non-goals:

- migrating store contents across formats (Coral has never supported this);
- writing `PRAGMA user_version` to appease retired generations;
- re-keying the coordinator socket (deferred — see Deferred work);
- recovering the already-quarantined 72 MB store as active state;
- deleting cached older plugin versions; and
- changing `schema.sql` (any DDL edit changes the fingerprint and resets every
  current store — see Cost of schema edits).

## Required invariants

### 1. Store path carries the store-format identity

The store directory is keyed by the store-format fingerprint. Two builds whose
fingerprints differ can never open the same file. Two builds whose fingerprints
agree continue to share one store, which is correct: they are format-compatible
by construction.

### 2. The reset precondition becomes true

`openStoreDatabase`'s destructive path currently rests on an unstated
precondition: _the store in `dbDir` belongs to this build set._ Under
`storePaths(flavor)` that is false, which is why quarantining destroys data.
Under a fingerprint-keyed path it holds by construction:

- `fresh` / `current` — unchanged, normal operation.
- `missing` in a directory named after my own fingerprint — my own history always
  carries the row, so this is not my history. Reachable only by partial backup
  restore, corruption, or a hand-placed file. Quarantine and boot is correct.
- `mismatch` in my own directory — a store naming another format under my key.
  Reachable only by moving files. Same conclusion.

The reset therefore stays automatic. This is the strongest argument for path
isolation over a refuse-to-boot design: the ~900 lines of crash-safe quarantine
machinery stay live and correct instead of becoming dead code behind a refusal.
Note there is no manual reset command today — `backend store-reset` is
inspection-only (`src/cli/commands/backend.ts`) — so a refuse-and-reset-manually
design would have to invent one and would strand the existing machinery.

### 3. The DB row remains the only classifier

The `store.db.format` sidecar must never participate in classification. It has a
legitimate different consumer: `clients/hooks/pre-compact.mjs:63-97` reads it as
a cheap pre-flight before opening SQLite, because hooks may not import `src/`.
It is a registered persisted codec (`src/store-format.ts`, contract
`'<store.db>.format'`).

The row is truth. The row is written inside the schema transaction; the sidecar
is written outside it by any process that opens the store and is never removed.
The affected machine proves it lies: `store.db.format` (22:51) still describes a
database the older generation quarantined at 23:07 — an orphan naming a store
that no longer exists. Consulting it during classification would have made the
incident worse and would create a second canonical home for "what format is this
store".

### 4. The hook's derived path mirrors `storePaths`

`clients/hooks/pre-compact.mjs` must derive the same path. Hooks cannot import
`src/`, so the duplication is mandated by design philosophy §6 and an invariant
must assert the two agree.

## Why the store-format fingerprint is the key

- **`buildSetId`** — `randomUUID()` per build (`scripts/build-server.mjs:34`).
  Orphans all history on every local rebuild.
- **`version`** — orphans history on every release even when the schema is
  unchanged.
- **`bundleHash`** — same defect as `buildSetId`.
- **store-format fingerprint** — changes exactly when the store becomes
  incompatible. `0.10.3 → 0.10.4` with an unchanged schema keeps one store. The
  only candidate whose granularity matches the compatibility boundary.

## Implementation

Every consumer already holds a `StoreFormatDescription`, which is what keeps this
change small:

| Site                                                     | Already has                        |
| -------------------------------------------------------- | ---------------------------------- |
| `src/store/db.ts` `resolveStoreDbPath`                   | `options.storeFormat`              |
| `src/store/backend-store-reset.ts` `resolveStoreFileSet` | `options.storeFormat`              |
| `src/store/read-port.ts`                                 | `options.storeFormat`              |
| `src/cli/read-store.ts`                                  | passes `currentCoralStoreFormat()` |
| `src/cli/store-reset.ts`                                 | `manifest.storeFormatFingerprint`  |
| `clients/hooks/pre-compact.mjs`                          | `currentStoreFormatFingerprint()`  |

1. **`src/infra/path/store.ts`** — `storePaths(flavor, storeFormatFingerprint, opts?)`.
   Add an unexported `storeFormatKey(fingerprint)`: validate
   `/^sha256:[0-9a-f]{64}$/`, return the first 16 hex characters (matching the
   existing 16-hex `bundleHash` convention), throw `TypeError` otherwise.
   `dbDir` becomes `join(coralStateRoot(opts?.baseDir), base, storeFormatKey(fp))`;
   `base` stays `data/store` | `data-dev/store`; filenames stay `store.db`,
   `store.db-wal`, `store.db-shm`. Result: `~/.coral/data/store/<16hex>/store.db`.

   This introduces no `infra → store` dependency: the fingerprint arrives as a
   parameter and its shape is already infra vocabulary
   (`STORE_FORMAT_FINGERPRINT_PATTERN` in `src/infra/bundle-manifest.ts`).

   The reset lock (`store.db.reset.lock`), the quarantine root
   (`store-reset-quarantine/`), and the sidecar all derive from `dbDir` and move
   for free — **zero string-literal churn**.

2. **`src/infra/path/index.ts` and the `CoralPaths` declaration** — `store`
   becomes `(storeFormatFingerprint: string) => StorePaths`. Precedent in the same
   file: `projectsPaths` returns `{ root, dataDir: (source) => … }`. This keeps
   `createRealRuntime(flavor)` unchanged and the port object an eager constant
   (design philosophy §4). Call sites become
   `runtime.paths.coral.store(options.storeFormat.fingerprint).dbDir`.

3. **`clients/hooks/pre-compact.mjs`** — `storeDbPath()` takes the fingerprint and
   mirrors `storeFormatKey`. Move the existing `expectedFingerprint === null`
   guard above the `existsSync(dbPath)` check. The hook's two match checks become
   assertions that cannot fail in normal operation, so the hook simplifies.

4. **New `src/store/legacy-store-adoption.ts`** — one-time forward-only adoption,
   called from `openOrResetBackendStoreDb` immediately after
   `acquireDirectoryLockSync` and before `resumeInterruptedIncident`. Guards that
   keep it from becoming a second canonical home:
   1. runs only when the keyed directory has no `store.db`;
   2. classifies the legacy `<base>/store.db` read-only and **only if `current`**
      renames the whole set — `store.db`, `-wal`, `-shm`, `.format`, and the
      legacy `store-reset-quarantine/` — into the keyed directory (same
      filesystem; the keyed-directory lock serializes same-generation contenders);
   3. otherwise touches nothing; and
   4. never reads the legacy path again.

   This is forward-only migration in an honestly-named, deletable module, not a
   compatibility shim. The store already treats migration as first-class through
   envelope upcasters.

5. **Promote `classifyStoreFile`** from module-local in
   `src/store/backend-store-reset.ts` into `src/store/db.ts` beside
   `classifyStoreFormat` — two call sites after adoption, and it is the
   file-level counterpart of the same concept. Not a content-blank helper file.

6. **`tests/invariants/flavor-path-separation.test.ts`** — extend (it already owns
   "every path family separates by flavor"): assert the store family separates by
   store-format key, and assert the hook's derived path equals
   `storePaths(flavor, fp).dbFile`. No hook↔`src/infra/path` mirror invariant
   exists today; this one is load-bearing.

## Operator visibility

Three items, all required — isolation without them converts silent destruction
into silent amnesia.

1. **`store-reset list` must not regress.** `src/cli/store-reset.ts` resolves the
   quarantine root from the manifest's flavor, so after this change it looks only
   inside its own keyed directory and the existing 72 MB incident (in the legacy
   un-keyed root) would become invisible. Adoption fixes this when the legacy
   store is `current`; otherwise the notice must name the legacy path. Do **not**
   scan both roots — that is the second-canonical-home trap.
2. **Fresh-store notice.** In `openStoreDatabase`'s `fresh` branch for a real
   path, one `readdir` of the parent directory; if sibling format keys or a legacy
   `store.db` exist, emit: _"Started a new store for format `<key>`; earlier
   history remains at `<path>` and is readable by the Coral version that wrote
   it."_
3. **Put it where the user reads.** `clients/hooks/session-start.mjs` already
   emits `additionalContext`. A retained one-line notice there beats
   `emitStoreResetStartupNotice`'s one-shot stderr write, which reaches only
   whichever process happened to spawn the coordinator — often a hook whose
   stderr nobody reads — and is not retained.

## Cost of schema edits

The fingerprint is derived from the DDL plus persisted codec contracts, so **any
`schema.sql` edit resets every current store.** Two consequences:

- Cosmetic schema cleanups are not free. `meta.coordinator_id` is written
  (`schema.sql:215`) and read nowhere in `src/`; removing it would reset every
  store for no user benefit. Keep it (see Deferred work — it is the natural home
  for the ownership lease the coordinator re-key needs).
- Any intentional format change should carry pending schema cleanups with it,
  since the reset is already being paid for.

## Deferred work: coordinator socket re-key

The same defect applies to the coordinator socket, and the right key would be
`flavor + namespace` (`namespace` is already on `RawCoordinatorHealth`,
`VerifiedBackendInfo`, discovery, `/health`, and every job record; `bundleHash`
would respawn on every local rebuild and wreck the dev loop). Principle 2 ("One
Coordinator, Two Authorities") survives: it concerns which component owns which
truth, not OS process count, and prod/dev already run two coordinators.

**This plan does not do it, because the prerequisite fails.**

Two same-flavor coordinators have never run concurrently, so two coordinators
have never shared a `store.db`. Investigating whether they safely could:

- **Append is safe.** `src/store/append.ts` reserves `seq` by `MAX(seq)+1..N`
  under `BEGIN IMMEDIATE`, which SQLite serializes across processes.
- **SQL projections look tolerant.** Each projection row carries its own
  `last_seq`, and the consumer cursor advance is guarded
  `UPDATE consumer_cursors SET cursor = ? WHERE consumer_id = ? AND cursor < ?` —
  monotonic, so a stale driver cannot rewind it.
- **The store lock does not help.** `store.db.reset.lock` is acquired in
  `openOrResetBackendStoreDb` and released in its `finally` immediately after the
  database is opened. It guards the classify-reset-open window only, not the
  daemon's lifetime.
- **The blocker: `consumer_cursors` is a single global row per `consumer_id` with
  no owner lease.** Two coordinators would both claim e.g. `orama-base`. Beyond
  duplicated work, consumers with external side effects — the Orama index, and
  Corpus/KB markdown through the KB daemon — would be driven by two processes at
  once. Two coordinators means two KB daemon supervisors writing one KB tree.
- `meta.coordinator_id` being written and never read reads as a vestige of
  precisely the ownership lease that is missing.

**Order: ship store isolation alone. It needs none of this.** Re-key only after
a projector/consumer ownership lease exists. Shipping the re-key first would
trade data loss for data corruption — strictly worse.

**If the lease proves expensive, keeping flavor-only coordinator singularity is
an acceptable end state.** Cross-version alternation then costs up to 30 s drain
plus 15 s startup per flip, and work outliving the graceful drain budget loses
its coordinator — expensive but recoverable, nothing destroyed that cannot be
re-run. Once the store is fingerprint-keyed no alternation can destroy history,
which demotes the remaining problem from a correctness defect to a performance
one. Child confinement (`fix/child-handoff-recovery-hooks`) already removed
nested invocations as a source of flips.

Independent cheap improvement, worth doing either way: when a job lookup misses
and the store holds that job under a different namespace, say so — _"job `<id>`
belongs to Coral namespace `<ns>` (plugin root `<path>`); it is visible to
sessions started from that installation."_ Every job record carries its
namespace. Belongs where `job_not_found` is produced.

## Test and CI gap

Two e2e lifecycle tests were failing on `main` outside every gate. `npm test`
runs typecheck plus `vitest/default.ts` and `vitest/simulation.ts`;
`.github/workflows/ci.yml` runs `build`, `test`,
`test:store-reset:integration`, `verify:store-reset-build`, and
`test:e2e:store-reset:build` — never `test:e2e:lifecycle`.

`tests/e2e/cli/lifecycle/mutate-via-ipc.test.ts` is repaired (commit
`9f120f75`). The remaining work, in order:

1. **Narrow `tests/e2e/lifecycle/flavor-coexistence.test.ts` and rename it to
   namespace coexistence.** Its premise is unachievable: it builds a prod and a
   dev fixture from one build set by relabeling `flavor` in the manifest, but
   flavor is `define`-injected at build time and `resolveStrictBundleIdentity`
   requires `manifest.flavor === embedded.flavor`. It also writes a three-field
   manifest (`parseStrictManifest` rejects it) and copies only
   `coral-backend.cjs` while strict identity hashes all three artifacts.

   Its assertions are almost entirely about **namespace** isolation — distinct
   namespaces, pids, ports, instance ids, namespace-scoped job visibility, and
   cross-namespace `job_not_found`. Two _prod_ fixtures at different plugin roots
   exercise every one. The flavor assertions merely echo what the fixture wrote.
   The genuinely flavor-specific claims (`data` vs `data-dev`, separate run dirs)
   are pure path properties already covered by
   `tests/invariants/flavor-path-separation.test.ts`.

   Rebuild the fixture in the shape of `tests/integration/coordinator/helpers.ts`
   `createPluginFixture` (all three bundles, verbatim `clients/build/manifest.json`),
   drop the manifest-equality assertions, keep every isolation assertion. This
   also becomes the direct regression guard for a future coordinator re-key.

2. **Add the test that would have caught this defect** — in-process, sub-second,
   fails before isolation lands, so it must land _with_ the implementation.
   `describeStoreFormat(ddl, codecs, ddlFragments)` is exported and takes DDL
   fragments, so a test can synthesize a second format from the real one plus a
   throwaway fragment. Assert: (i) the two formats resolve to different `dbDir`s;
   (ii) opening under A, then under B, leaves A's `store.db` byte-identical with
   no quarantine incident; (iii) A's data is still readable after B ran.

   An e2e can never cover this defect class: it is cross-_generation_, and no
   single source tree can build two generations.

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

Manual adoption check, against a disposable `HOME`: create a current-format store
under the legacy un-keyed path, boot, and confirm the files moved into the keyed
directory with no quarantine incident published and `backend store-reset list`
still resolving prior incidents.

## Acceptance criteria

- Two builds with different store-format fingerprints never resolve to the same
  `store.db`, asserted by an invariant.
- The hook's derived store path equals `storePaths(flavor, fp).dbFile`, asserted
  by an invariant.
- An existing current-format store is adopted once into the keyed directory, with
  its quarantine history, and the legacy path is never read again.
- A store whose format differs is left untouched, not quarantined.
- A fresh store in a new format tells the operator where earlier history lives.
- `backend store-reset list` still resolves incidents recorded before the change.
- The sidecar is still written and still read only by the hook pre-flight and as
  reset evidence; it never classifies.
- `schema.sql` is unchanged, so no existing current-format store is reset by this
  work.
- `test:e2e:lifecycle` passes and runs in CI.

## Open questions

- Should adoption also cover `~/.coral/data/kb/`? That directory was written at
  23:07 by the older generation with its umask (`drwxrwxr-x`, unlike the `0700`
  directories current code creates), suggesting the same flavor-only keying
  hazard. Not traced.
- `classifyStoreFile` classifies through a read-only handle, then
  `openStoreDatabase` classifies again writable. For a WAL database whose `-shm`
  is absent or unwritable, a read-only open can fail outright rather than
  returning a classification, and that throw is not wrapped at the call site.
  Plausible from SQLite's read-only WAL semantics; untested. Unrelated to this
  plan.
