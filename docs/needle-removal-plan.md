# Needle Engine Removal Plan

Status: frozen landing plan after three independent approvals; delete at closeout.

## Objective

Remove Needle completely from Coral's current source product, extension
catalog, tests, and current documentation while preserving the provider-neutral
vector and embedding extension contracts that are not owned by Needle.

This is a clean removal. It introduces no retired-id shim, compatibility
tombstone, deletion guard, or replacement vector engine. Older installations
retain a supported provider-neutral retirement command:
`coral-cli expansion remove-catalog <retired-id>`. Explicit operator authority,
not an inferred ownership relationship, permits cleanup after an expansion has
left the catalog.

## Governing Decisions

1. Needle owns its native addon installer, store adapter, projection identity,
   snapshot publication, artifact port, vector backend, expansion entry point,
   and all tests whose protected behavior exists only in those implementations.
   They are removed together.
2. `kb.vector`, `kb.embedding`, vector/hybrid query routing, expansion
   lifecycle, onboarding, capability binding, consumer freshness, and generic
   engine paths are provider-neutral product contracts. They remain.
3. A test that currently uses `needle` only as an arbitrary engine, consumer,
   binding owner, CLI argument, or vector provider keeps its coverage under a
   neutral fixture identity. A test of Needle installation, addon validation,
   snapshot publication, crash recovery, artifact decoding, or expansion
   activation is deleted.
4. Current user and architecture documentation must not advertise Needle,
   Needle paths, its addon metadata, or Needle-backed semantic search.
5. Checked-in `clients/bridge/**` files remain the immutable bundles of the
   previous release until the Release workflow rebuilds them for the next tag.
   Coral policy explicitly forbids feature PRs from refreshing those bundles;
   final residue checks therefore exclude `clients/bridge/**` while verifying
   newly built `clients/build/**` artifacts are Needle-free.
6. `expansion_state` does not record consumer or filesystem ownership, so boot
   recovery must not infer destructive authority from an orphan row. Boot
   preserves catalog-absent rows without activating them. Explicit
   `remove-catalog <retired-id>` is the sole authority that may retire them.
   Retirement routing is allowed only when the id is absent from every current
   product catalog: static and installed manifests plus install-only packages.
7. Installed expansions are trusted code, not filesystem-sandboxed plugins:
   they receive a full runtime and can import Node filesystem APIs. Retirement
   therefore derives filesystem deletion authority from the operator's
   explicit command, not from a false confinement claim. Coral still enforces
   the provider contract before retirement is enabled:
   - cursor-bearing `registration_kind='expansion'` consumers must use the
     owning `host.id`; stateless provider registrations remain unconstrained;
   - installed manifests must pass the same canonical safe-id and reserved-name
     validation at persistence and equip ingress;
   - trusted installed extensions must keep legacy projection artifacts in
     `<kb.runtimeDir>/<host.id>` and `<host.id>-staging`; the host supplies
     these scoped paths, but this is an API contract rather than a sandbox.
   A current catalog entry, active same-id consumer, or cursor ownership
   conflict blocks retirement. Arbitrary trusted-code violations are outside
   the destructive command's ownership proof and are not claimed safe.
8. One provider-neutral KB runtime reservation authority owns every current
   top-level file and directory name and both validates retirement targets and
   supplies the names used by current producers. Future top-level producers
   must register there. Retirement validates a conservative cross-platform
   canonical id grammar (`[a-z][a-z0-9]*(?:-[a-z0-9]+)*`) before path
   composition. It rejects Windows device names and all aliases outside that
   grammar, including empty/dot segments, separators and absolute/drive/ADS
   forms, control/NUL characters, case variants, and trailing dots/spaces. It
   also rejects any id for which either inferred `<id>` or `<id>-staging`
   collides with an exact or patterned reserved KB runtime authority.
9. A provider-neutral package-operation lock lives in a stable `.locks` tree
   beside, never inside, engine data directories. It carries a unique fencing
   token and heartbeat, cannot be stale-stolen while its live owner refreshes
   it, and releases only when the token still matches. Every supported
   install/update/uninstall writer holds it across artifact mutation and
   post-install manifest registration. Retirement holds the same per-id lock
   from its first live catalog read through final state deletion. A fresh
   database catalog read under that exclusion—not the boot-time in-memory
   manifest map—is authoritative, so no supported registration can appear
   between authorization and completion.
10. One canonical identity binds the CLI package name, lock key, artifact
   target, post-install manifest id, persisted row key/decoded manifest id, and
   eventual host id. Every boundary requires exact equality; a mismatch fails
   before registration or mutation. DB-installed rows must be `tier:
   'installed'`; a persisted row-key/JSON-id or source/tier mismatch fails
   closed rather than loading as a base/bundled host.
11. The `ConsumerDriver` owns retirement preflight because it owns active
   registrations. It rejects a live same-id consumer, then delegates persisted
   metadata classification and conditional deletion to
   `ConsumerCursorRepository`. The repository reports missing,
   expansion-owned, or blocked/invalid, fails closed for
   `registration_kind='base'` or malformed metadata, conditionally deletes only
   `registration_kind='expansion'` and verifies exactly one affected row; a
   changed or missing row fails closed. After a successful preflight,
   retirement removes only:
   - the exact flavor-aware engine data directory for that id;
   - the exact legacy projection and `-staging` directories for that id;
   - the preflighted same-id expansion cursor;
   - a same-id durable expansion state row.
   A same-id base cursor or an invalid/reserved id fails before deletion.
   Missing paths and rows are idempotent success. The state row is deleted last
   when present; any earlier failure leaves it as a retry marker, while a
   rowless partial cleanup is completed by rerunning the explicit command.
   No source code names a retired engine.

## After-State Authority Map

| Concern | Authority after this landing | Retained evidence | Removed Needle surface |
| --- | --- | --- | --- |
| Text retrieval | Bundled Orama `kb.fts` expansion | Orama unit, artifact, search, and freshness tests | none |
| Vector extension contract | `KB_VECTOR_CAPABILITY`, `VectorRetrieval`, capability registry, search router | Neutral fixture-backed vector and hybrid search tests | Needle backend and snapshot/store adapters |
| Embedding extension contract | `KB_EMBEDDING_CAPABILITY`, Gemini and ONNX peer expansions | Existing peer expansion, onboarding, binding, and remediation tests | Needle's embedding requirement and projection identity |
| Expansion lifecycle | Generic manifests, lifecycle service, installer contracts, engine path authority | Neutral manifest/engine fixture tests and install-only package coverage | Needle catalog entry, native installer, activation tests, multi-process install race |
| Projection artifacts | Generic artifact registry plus Orama artifact port | Registry and Orama artifact tests | Needle artifact port and native-store validation |
| Removed expansion state | Explicit operator-authorized `remove-catalog` retirement cleanup | Full-boot upgrade fixtures covering row-bearing and install-before-activation residue, cursor ownership, path safety, catalog protection, flavor isolation, and retry | Needle-specific cleanup shim or unsupported manual filesystem surgery |
| Documentation | Current README and docs describe only available product behavior | Documentation review and source residue audit | Needle feature, path, readiness, and build-metadata claims |

## Scope

### A. Product implementation and catalog

- Delete `src/engines/needle/**`.
- Remove the Needle installer import and Needle manifest from
  `src/expansion/bundled.ts`.
- Remove Needle-specific comments and examples from generic expansion and
  readiness code without changing those generic contracts.
- Remove Needle-specific architecture invariants and synthetic identifiers;
  keep stronger provider-neutral engine-boundary rules.
- Extend the existing `removeExpansionCatalog` lifecycle path so an id absent
  from the current static and installed manifest catalogs and the install-only
  package catalog invokes an injected, provider-neutral retirement cleanup port
  and returns the existing `removed` result. Current catalog entries retain
  their existing immutable/dependency checks; current install-only entries are
  rejected as non-retired through both CLI and direct RPC.
- Replace installer-private locks with one provider-neutral package-operation
  lock rooted outside `engine.dataDir(id)`. Use heartbeat plus owner-token
  fencing, and keep it held across install/update/uninstall artifact work and
  post-install catalog registration. The catalog-absent lifecycle branch holds
  the same lock across its fresh SQLite catalog lookup, filesystem retirement,
  conditional cursor deletion, and final state-row deletion. All supported
  manifest registration writers participate; do not authorize from the
  lifecycle's boot snapshot.
- Bind the package operation's identity end to end: package argument, stable
  lock key, engine target, every `postInstall` manifest id, SQLite row id,
  decoded manifest id, and host id must match exactly. Reject multiple/different
  post-install ids rather than acquiring implicit extra locks. Persisted
  installed-catalog entries must have `tier: 'installed'`; reject row/JSON id
  and source/tier mismatches at read and write ingress.
- Change boot recovery so a catalog-absent durable state row is preserved and
  skipped rather than deleted or activated. Include these rows in the existing
  expansion status/list RPC as `installed-not-active`, with a provider-neutral
  actionable error containing
  `coral-cli expansion remove-catalog <retired-id>`. This persisted status—not
  child stderr—is the operator-visible diagnostic. Failed cleanup and restart
  must continue to preserve and expose the row.
- Strengthen installed-expansion identity at manifest and host boundaries.
  Validate canonical safe ids and reserved-name collisions before persisting a
  manifest or constructing a host. A cursorful expansion registration must use
  its manifest/host id; stateless provider registrations remain valid. Supply
  trusted installed expansions canonical own-id projection/staging paths and
  document that extension code must use them; do not claim the API is a
  filesystem security sandbox.
- Implement the runtime cleanup port against canonical flavor-aware engine and
  KB runtime roots supplied by composition:
  `runtime.paths.coral.engine.dataDir(id)` and the active `kb.runtimeDir`.
- Add one KB runtime top-level reservation module used by all existing
  producers and by retirement validation. It covers current root authorities,
  including Orama data, corpus and generated-community projections,
  source-import staging/PDF, promote recovery, migration/version state,
  mutation lock, index files/state, touch-journal exact files, and patterned
  orphan segments. Pin each producer-to-authority mapping in an architecture
  invariant. Validate both inferred legacy projection basenames before any
  filesystem or DB mutation.
- Add a `ConsumerDriver` retirement/preflight port that rejects an active
  same-id registration before any filesystem mutation, then delegates cursor
  metadata classification and conditional affected-row deletion to
  `ConsumerCursorRepository`. The
  lifecycle remains the orchestration and expansion-state authority and
  deletes the state row only after filesystem and cursor cleanup succeed.

### B. Tests

- Delete the four `tests/unit/engines/needle/**` suites.
- Delete the Needle native-installer cases from
  `tests/unit/expansion/install.test.ts`; retain generic unknown-package and
  artifact-removal behavior with neutral fixtures.
- Delete the Needle-only multi-process installer race integration suite.
- Remove the Needle half of artifact-port blindness coverage while retaining
  the registry and Orama authority checks.
- Replace Needle names in generic CLI, lifecycle, readiness, binding, vector
  search, path, transport, and integration fixtures with explicit neutral
  fixture identities.
- Preserve vector/hybrid search and embedding-remediation coverage; those are
  product contracts, not Needle tests.
- Add table-driven full-boot upgrade fixtures for a removed neutral expansion
  id using real current-format on-disk SQLite stores and production-composed
  `prod` and `dev` roots. For both flavors, seed both flavor roots and
  stores, invoke cleanup in one, and prove the opposite flavor is untouched.
  Each fixture must complete production-composed boot, assert the orphan row
  remains inactive with unchanged files/cursors and an actionable list/status
  diagnostic, then invoke cleanup through daemon RPC. At least one
  representative success and rejection case also runs through the built CLI.
  Cover:
  - row + expansion cursor + engine data + projection + staging cleanup;
  - install-before-activation residue with no state row;
  - missing paths/rows as idempotent success;
  - same-id base or malformed cursor metadata rejecting before deletion while
    the state row, all residue trees, unrelated cursors, and sentinels remain
    byte-for-byte unchanged;
  - an invalid-id table covering empty/dot/dot-dot, POSIX and Windows
    separators/absolute forms, control characters, every registered KB
    top-level authority, and collisions through both `<id>` and
    `<id>-staging`, with zero DB or filesystem mutation;
  - failure immediately before state-row deletion after paths and expansion
    cursor are gone, then restart and a successful second command proving the
    row was the final retry marker;
  - a partial rowless cleanup failure followed by a successful idempotent
    retry.
- Add exact positive catalog assertions for the remaining manifest ids and
  tiers plus the install-only package ids. Test that Gemini, ONNX, Orama, Kiwi,
  and codebase-memory cannot enter retired cleanup through direct RPC or CLI.
  Add a DB-installed manifest fixture proving existing catalog-removal
  semantics without entering retirement. Use real supported installer and
  retirement workers with barriers to cover install-before-retire,
  registration-after-authorization, and retire-before-install ordering. Prove
  the stable external heartbeat/fencing lock remains present and exclusive
  through final state commit and release. Pin the compatible absent-id RPC
  result (`removed`), CLI rendering (`uninstalled`), idempotency, and
  invalid/reserved-id errors.
- Add repository-level cursor preflight cases for missing, expansion-owned,
  base-owned, malformed, active, and ownership-changing rows. A conditional
  delete that affects zero rows must fail closed.
- Pin the strict safe-id aliases/device-name rejection matrix and the complete
  exact/patterned KB reservation set plus every producer mapping; do not derive
  the expected set from the registry under test.
- Prove manifest persistence/equip rejects unsafe, aliased, device, and
  reserved ids before host construction or any storage call. Prove foreign
  cursor ids fail before repository registration, stateless ids remain
  allowed, own-id cursor registrations work, and bundled/core engines retain
  their registered authorities.
- Prove exact identity equality across package/lock/target/post-install
  manifest/row/decoded manifest/host boundaries. Mismatched post-install ids,
  legacy row-key/JSON-id drift, and a DB-installed `tier:'bundled'` entry must
  fail closed without registration, artifact deletion, or host construction.
  Pin active-consumer rejection through the `ConsumerDriver`-owned preflight,
  not a repository mock.
- Through the built CLI, prove a catalog-absent durable row is merged into
  `expansion list` as a provider-neutral retired-residue entry with
  `installed-not-active` status and its interpolated literal cleanup command,
  and remains visible after restart.

### C. Documentation

- Remove Needle feature claims from both READMEs.
- Update architecture, core-module, configuration, and build-system docs so
  their present-tense behavior and path inventories match the remaining
  product.
- Include `docs/design-rationale.md` and perform a semantic audit for generic
  claims that would become false even when they do not contain a Needle
  identifier, including README setup claims and Orama/vector behavior.
- Update provider-neutral command help and operator documentation so
  `remove-catalog` clearly covers artifacts left by catalog-absent retired
  expansions. State the after-state accurately: Orama provides FTS only;
  Gemini/ONNX provide embeddings only; no current first-party package fills
  `kb.vector`; auto search remains text-capable while vector-dependent
  modes/readiness require an external provider.
- Extend the CLI catalog projection/schema so a daemon lifecycle row absent
  from all current catalogs is rendered as a provider-neutral retired-residue
  package with its `installed-not-active` status and actionable cleanup
  command; do not silently drop it from `expansion list`.
- Put the one-release rowless-upgrade diagnostic in the PR title as well as the
  body. Both must contain the actual retired id and literal runnable command
  `coral-cli expansion remove-catalog needle`; verify the created PR metadata
  before handoff so GitHub's `--generate-notes` release flow publishes the
  title. This makes
  install-before-activation residue actionable without retaining a removed
  identifier in Coral's final repository tree.
- Use the exact title
  `feat: remove Needle; upgrade cleanup: coral-cli expansion remove-catalog needle`
  and create the PR with exactly `--label enhancement` in the same command.
  Verify title, body, and sole type label after creation.
- Do not add historical Needle notes or a removed-feature inventory.

## Explicit Non-Goals

- No replacement vector engine.
- No removal or redesign of generic vector search, hybrid fusion, embedding
  services, Gemini, ONNX, capability binding, expansion lifecycle, consumer
  freshness, or canonical engine roots. The identity and trusted-extension
  contracts above tighten mutation authority without removing those contracts.
- No Needle-specific migration, hard-coded retired expansion inventory, or
  automatic filesystem scan.
- No boot-time deletion inferred from an orphan state row.
- No rebuild of `clients/bridge/**` outside the Release workflow.
- No test or source scanner whose purpose is to enforce Needle's absence.
- No version bump or release.

## Commit And Push Sequence

Every commit is pushed immediately after creation.

1. `feat: remove the Needle engine`
   - includes this frozen plan;
   - removes all current product, test, and documentation surfaces in one
     coherent commit so no pushed revision contains orphan imports or a broken
     catalog.
2. `chore: address Needle removal review`
   - created only when tier review produces valid in-scope corrections;
   - may repeat after a blocking review round.
3. `chore: close Needle removal`
   - deletes this temporary plan after final review, validation, and residue
     checks.

## Review And Validation

Before implementation:

- exactly three fresh independent reviewers inspect this same plan revision;
- reviewers are constrained to this landing and classify ownership,
  dependency, invariant, or impossible-acceptance defects as blocking;
- every valid in-scope detail is incorporated;
- structural plan changes trigger a new three-reviewer round;
- implementation begins only after at least two reviewers approve the current
  structure.

After implementation:

- run Coral's `.claude/skills/tier-review` protocol on the actual diff;
- apply every valid in-scope improvement;
- repeat immediately with fresh agents after any blocking finding;
- stop after applying one detail-only round with no blocking finding.

Final validation, after the review loop:

- `git diff --check`
- `npm run format:check`
- `npm run lint`
- `npm run typecheck:tests`
- `npm run knip`
- `npm run build`
- `npm test`
- `npm run test:integration`
- `npm run verify:store-reset-build`
- `npm run test:e2e:build`

With this temporary plan still present, run a preliminary case-insensitive
residue search across tracked source, tests, documentation, manifests,
workflows, and newly built artifacts, excluding only this plan and the
policy-defined prior-release `clients/bridge/**` bundle.

Then delete this plan and run:

- `git diff --check`
- the same final-tree residue search with no plan exclusion and only
  `clients/bridge/**` excluded

Create and push the closeout commit, open a pull request, and wait for the Node
24 and Node 26 CI jobs.

## Acceptance Evidence

- `src/engines/needle/**` and all Needle catalog/installer imports are absent.
- No current source, test, documentation, manifest, workflow, or
  `clients/build/**` artifact contains a Needle identifier.
- The generic vector and embedding contracts retain behavior-based coverage
  under neutral fixtures.
- Needle-only tests are gone rather than converted into deletion guards.
- All required validation commands pass.
- Every implementation, correction, and closeout commit exists on the remote
  branch.
- The final worktree is clean and the pull request is open with green CI.
