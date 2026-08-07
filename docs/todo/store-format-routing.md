# TODO — store-format routing (and its blocking interaction with cross-version continuity)

**Status**: the build-selection pointer described below is implemented; the fingerprint-keyed multi-format routing proposed by this document is designed far enough to know its shape and one blocking conflict, but remains open and unplanned.
Split out of the containment-boundary preplan on 2026-08-02.

**Why it is not part of containment**: routing shares coordinator election, cold start, and
high-water identity with the cross-version continuity work — since landed, and described by
`architecture.md`'s "Generation boundary and operator recovery" section — not with containment.
Designing it apart from that work would recreate the conflict recorded below, which a
pioneer pass caught only because both were considered together.

> **What this is NOT needed for.** Zero-step replacement of older or corrupt/unsupported
> state is implemented without format routing. When the running bundle directory is
> resolvable, the active-store selection protocol now also handles both newer-store cases
> without operator action:
>
> | Store relative to the running build | Newer build installed | Current behaviour                                                                                                                | Status      |
> | ----------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------- |
> | older                               | —                     | auto-quarantine with a V3 incident, initialize fresh                                                                             | implemented |
> | corrupt or unsupported              | —                     | auto-quarantine with a V3 incident, initialize fresh                                                                             | implemented |
> | newer                               | yes                   | the active-store selection names a valid newer local build, so startup hands off to it                                           | implemented |
> | newer                               | no                    | an absent, malformed, or invalidated selection publishes a V3 `newer-incompatible-invalid-target` incident and initializes fresh | implemented |
>
> The implemented authority is the build-identity selection pointer
> `active-store-selection.v1.json`. `coordinateActiveStoreSelection` consults it before
> classifying store bytes, hands off to a valid newer local target, and records a durable
> transition before resetting an invalid-target newer store. This remains one store path per
> flavor; it is not the fingerprint-keyed multi-format routing proposed below.
>
> Routing is a _further_ refinement: an older build would find its own store instead of
> needing either branch, and quarantine would stop being necessary at all. Do not treat it
> as the prerequisite for the already-implemented older/corrupt zero-step path — it is not.

## The problem it solves

One store per flavor means a build can meet a store it cannot read. Ordinary boot now
auto-quarantines older or corrupt/unsupported state. For a newer store, the build-selection
pointer hands off to a valid newer local build or, when the selection is absent, malformed,
or invalidated, auto-quarantines with a V3 incident and initializes fresh. That is safe
cross-version ownership over one store path, not multi-format routing.

The remaining routing problem is that an older build cannot find and open its own
format-compatible store; it must hand authority to the selected newer build or replace the
single active store when no valid target exists. The dangerous state is **two builds with
different schemas alternating over one store** — the shape of the 2026-08-01 data incident.
Fingerprint-keyed paths would isolate those schemas while preserving each format's history.

## Shape (from pioneer, 2026-08-02)

**Unimplemented proposal.** What shipped is `active-store-selection.v1.json`, a
build-identity selection pointer with one store path per flavor. It does not create
`active-format.json` or `formats/<sha256>/store.db`; the fingerprint-keyed shape below
remains open.

Two identities, not one:

```
gen2/data/store/formats/<sha256-hex>/store.db   # path prevents opening the wrong schema
active-format.json            (flavor level)    # catalog prevents silent history forking
```

`active-format.json` holds the active/high-water fingerprint plus strictly validated build
identity. The path alone is **not** sufficient — see the residual cases below.

Rules established:

- **The coordinator stays singular per generation and flavor.** Keying `coordinator.json` or
  the socket by fingerprint would permit simultaneous coordinators over shared KB/runtime
  siblings. Add the active fingerprint to coordinator health/discovery for observability
  instead.
- Resolve store paths through something like `storePaths.forFormat(fingerprint)` rather than
  leaving a misleading singular `runtime.paths.coral.store.dbFile`.
- Use the 64 hex digits, or `sha256-<hex>` — `sha256:<hex>` is not a valid Windows directory
  name.
- **`gen2` is not redundant and must never be collapsed as a consequence of this.** It is a
  whole-tree layout/protocol boundary owning coordinator paths, store, KB runtime, engines,
  and generation coordination (`STATE_GENERATION`, `infra/path/root.ts:45`). A fingerprint
  partitions one family beneath it.

## Residual incompatibility that routing does NOT remove

**Open and unimplemented.** These residual points apply to the proposed fingerprint-keyed
paths, not to the shipped build-selection pointer.

The claim "no build ever meets an incompatible store" is false in four ways:

1. **`classifyStoreFormat` tests `precedence > 0` before fingerprint equality**
   (`store/db.ts:155`). Same fingerprint plus a newer stored product version still yields
   `newer-incompatible`. This is the same ordering that made every newer release lock out
   the previous one.
2. **A directory name does not authenticate its contents.** Corruption, a partial migration,
   an operator copy, or missing metadata still needs classification. The path is an address,
   not proof — the store opener must keep classifying, automatically resetting older/corrupt
   state, and applying the active-store selection protocol's handoff-or-reset decision for
   newer state.
3. **Same-fingerprint semantic incompatibility remains possible.** The fingerprint hashes
   DDL, Zod contracts, declared materializer contracts, and append-validator identities
   (`store/current-format.ts`'s `createCurrentStoreFormat`, `store/format-fingerprint.ts`'s
   `describeStoreFormat`) — not arbitrary reducer
   implementation. The structural rule must be that every persisted semantic expectation
   participates in the fingerprint; violating it is a format-contract bug that path
   partitioning cannot prevent.
4. **The layout transition itself carries the same fingerprint.** Changing only
   `storePaths()` does not change the format manifest, so a pre-keying build and a keyed
   build report the same fingerprint while opening different physical paths, and silently
   fork. A durable flat-path tombstone is required so a pre-keying build cannot see "absent"
   and start a second flat history. **That protocol was not designed.**

## Blocking conflict with cross-version coordinator continuity

**Open and unimplemented.** This section records the blocking conflict between the proposed
fingerprint-keyed paths and the wider cross-version coordinator continuity work — a plan that
lives outside this repo. The slice of it already shipped, the active-store selection pointer,
is covered by `architecture.md`'s "Generation boundary and operator recovery" section. That
shipped pointer externalizes the selected build identity while retaining one store path per
flavor; it neither implements `active-format.json` nor resolves the keyed-path and tombstone
protocol described here.

The earlier **Part E / AC20 proposal stored the high-water build inside the singleton
database** so an older cold-start build could discover the newer build and re-exec. With
fingerprint-keyed paths the older build would open its own older directory and never
encounter that database — it could boot an old history while stored-nonterminal work sits in
the newer one.

**Proposed fix: move the high-water identity into `active-format.json`.** Then live foreign
builds would be handled through the singleton coordinator, cold-start builds would consult
one format-neutral authority, format upgrades would atomically advance the active pointer,
and rollback would become explicit rather than a silent switch to a stale store.

Part C is compatible as-is: builds sharing a fingerprint share a store, removing namespace
tenancy lets the successor recover stored work, and `pluginRootNamespace` stays provenance
rather than ownership. `pluginRootNamespace()` must **not** enter the store path — it hashes
installation provenance, not storage compatibility.

## Decisions already made

- **Retention: operator-only prune.** Count has no semantic relationship to diagnostic
  value — the format needed for a bug report may be the sixth-oldest after several schema
  changes; age is worse. Automatic disk accounting and warnings are fine; automatic deletion
  is not. The command should select an exact fingerprint and report that the store, its
  quarantine table, and its reset incidents will be removed.
- **A fingerprint store is not "a specific version's store."** Multiple versions sharing a
  fingerprint mutate the same database and the product-version metadata advances. Retaining
  the format directory therefore does **not** satisfy version-specific evidence; that needs
  immutable reset incidents or explicit snapshots. This is why the containment preplan's
  cross-build-readability criterion was withdrawn rather than moved here unchanged.
- **Write-blocked-but-operating is rejected.** The static command map is 31 `mutate` vs 14
  `directRead`, 2 `servedRead`, 1 `subscribe`, and provider-family commands default to
  `mutate` (`cli/classify.ts:165`). A write-blocked daemon cannot launch providers,
  workflows, discussions, imports, session claims, or recovery settlements — it would look
  alive while being useless, which is the failure shape fixed on 2026-08-02. A typed refusal
  is cleaner; a deliberately diagnostic-only lifecycle that never reports `running` would be
  the only honest alternative.
- **`recovery_quarantine` belongs inside each fingerprint store.** Offender and quarantine
  share a schema, reverting to an older fingerprint restores that format's quarantine state,
  and pruning removes work and quarantine together. Complications: health and `clear` operate
  only on the active fingerprint, so historical quarantine needs an explicit fingerprint
  selector; and adding the table changes the fingerprint, so the first keyed build starts a
  new store rather than inheriting existing recovery candidates.

## Scope this would add

Store-root catalog and its lock, the tombstone migration barrier, historical fingerprint
selectors, and path updates in: `store/read-port.ts:35`, `store/db.ts:366`,
`cli/read-store.ts:107`, `store/operator-store-reset.ts:67`, and
`clients/hooks/pre-compact.mjs:25` (which hardcodes the flat path). Docs:
`architecture.md` items 3–5 and its "one canonical store per flavor" statement,
`configuration.md`, `hooks.md`.

Also decide the fate of the `.format` sidecar. It accompanies reset evidence and is declared
in `store-format.ts:38`, but normal opening only writes it (`store/db.ts:221`). Under a keyed
layout, either validate it as an external integrity witness or remove its contract and
incident role. Continuing to write it without consulting it is the least elegant state.

## Not verified

- The tombstone/catalog serialization and locking protocol — not designed.
- Whether every corpus consumer is idempotent under a `consumer_cursors` reset.
  `runCorpusApply` (`projection-consumers/authority-apply.ts`) reapplies the current
  corpus snapshot to shared runtime/index state, so "cursor reset is correct" is unproven.
- The historical frequency of fingerprint changes, which decides how many stores actually
  accumulate.
- No layout migration was executed or simulated.
