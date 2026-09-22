# TODO — routing-status contention is filed as an undeterminable artifact

**Status**: open, can start now. Filed 2026-09-22 from a field report on 0.10.10.

## Observed

The host ran byte-identical Coral 0.10.10 under two Claude config directories, with sessions from both open at once. `coral-cli jobs` printed its job list correctly, preceded on stderr by:

```
Handoff routing-status selection publication for invocation <id> was refused by artifact classification undeterminable.
Next step: retry coral-cli backend status without discarding, then rerun coral-cli backend status, then retry the operation if routing invocation <id> is still unresolved.
```

On that host the run directory held one `handoff-routing.<generation>.db`, mode 0600, and no `-wal` or `-shm` at rest.

The command itself was unaffected: a refused selection only skips the routing record, and the invocation runs current. Two installations of one build share one `~/.coral`, so every invocation from either config directory publishes into the same address.

## Why it happens (code path verified; the errcode on that host was not observable)

- `publishHandoffRoutingStoreTransaction` (`src/store/handoff-routing-status-store/artifact.ts`) opens the database and runs `classifyOpenHandoffRoutingStoreDatabase` before `configureDatabase` and before `BEGIN IMMEDIATE`. That classifier catches every throw and hands it to `unreadableOrUndeterminableClassification`. There, a primary errcode other than `SQLITE_ERROR`, `SQLITE_NOTADB`, or `SQLITE_CORRUPT` becomes `{ kind: 'undeterminable', cause: 'io-failed' }`, and that includes `SQLITE_BUSY`. `publicationActionForClassification` refuses `undeterminable`, so the publication returns `artifact-refused`.
- The same `SQLITE_BUSY`, thrown once the transaction has started, reaches `classifyPublicationError` (`src/coordinator/handoff-routing/status.ts`) and becomes `contended`. `publishHandoffRoutingTransitionsWithinWindow` retries exactly that cause. **One contention is therefore retried or refused depending on which statement meets it.**
- `readHandoffRoutingStoreSnapshotWithObservation` (same file as the first bullet) opens read-only with `busy_timeout=0` and runs the same classifier. The status and discard readers therefore report a transient contention as an artifact they cannot determine.
- `formatHandoffPublicationIncident` (`src/cli/format/handoff-publication.ts`) renders `artifact-refused` with `classification.kind` alone. It drops the `errcode` the classification carries, so the report cannot tell contention from an I/O failure. That is why the field report above could not be confirmed.

**Inferred, not confirmed:** the host's refusal was `SQLITE_BUSY`. A WAL database with no `-shm` must be recovered by the next opener, and the last closer checkpoints under an exclusive lock. With `busy_timeout=0`, any other connection that opens in either window fails its first read. The generation writer lease (`tryAcquireGenerationWriterLease`) serializes publishers, but not readers.

## Decided

- Contention is not an artifact disposition. `SQLITE_BUSY` / `SQLITE_LOCKED` met by the classifier must reach the caller as a distinct value that the publication retry loop consumes, exactly as the in-transaction path already does. It must not become `undeterminable`, which also means "the file cannot be observed" and is shared with the read path (design-philosophy §11: one value, one disposition).
- An exhausted retry window is reported as contention and names no command. Nothing is owed by the reader, so a `backend status` next step is noise the model will act on (§12).
- The `errcode` travels to the rendered incident. That part alone is cheap, and it turns the next field report into evidence.

## Out of scope

- The address lifetime of superseded generations: [`superseded-routing-generation-has-no-owner.md`](./superseded-routing-generation-has-no-owner.md).
- What `backend status` renders about resolved invocations: [`status-prints-history-it-should-not-carry.md`](./status-prints-history-it-should-not-carry.md).

Neither closes with this one.

## To start

Nothing blocks it.

- Rendering the `errcode` can land first and alone.
- The classification split needs a test that opens the store while another connection holds it. For example, one connection sits in `BEGIN EXCLUSIVE` while a publication and a status read run. The test must assert:
  - the publication is retried and then committed or reported as contention;
  - the read reports contention;
  - neither says `undeterminable`.
