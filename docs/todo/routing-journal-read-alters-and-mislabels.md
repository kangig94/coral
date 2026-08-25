# TODO — the routing-journal read alters what it inspects, and has no word for a journal that is neither ours nor foreign

**Status**: open, deferred from `fix/pr1-3-audit`. Both halves were found while that branch was making
publication prove ownership before writing; neither is caused by it, and neither blocks it. They are one
entry because they are two defects of the same function's contract — what
`readHandoffRoutingStoreSnapshot` (`src/store/handoff-routing-status-store.ts`) does to the artifact it
opens, and what it is able to say about it afterwards.

## Half one — an interrupted creation is reported as a foreign journal

`readHandoffRoutingStoreSnapshot` (`src/store/handoff-routing-status-store.ts`) answers
`absent | unsupported-generation | snapshot | failed`, and `readHandoffRoutingStatus`
(`src/coordinator/handoff-routing-status.ts`) turns that into the operator-facing
`absent | current | unreadable | unsupported-generation | undeterminable`. A zero-byte file at the
journal path takes the `unsupported-generation` arm in both: the file exists, so `assertReadableSync`
passes; SQLite opens it read-only; `PRAGMA user_version` reads `0`; `0` is not this build's generation.

Measured 2026-08-25, against `node:sqlite` on this host: a zero-byte file opens read-only without
error, reports `user_version` `0`, and reports zero `sqlite_master` objects. Nothing about it is
refused — it is simply not recognized.

A zero-byte file there is not a foreign journal. It is this build's own creation, interrupted:
`publishHandoffRoutingStoreTransaction` opens the path — which creates the file — and SQLite writes
nothing into it until the schema is applied a few statements later. A process that dies in that window
leaves exactly this.

The consequence is a wrong instruction rather than data loss. `backend status` renders
`unsupported-generation` as a durable 75 and names `backend routing-status discard` as the successor, so
an operator is told to take the destructive path against a file that holds nothing. Publication itself
self-heals — `databaseOwnership` classifies the same empty database as `empty`, and
`initializeOrValidateDatabase` then applies the schema — so the window closes on its own, and
discarding an empty file loses nothing. What is wrong is the label: this
branch's whole subject is that a third answer must not be collapsed into whichever binary the site
already had, and "not our generation" is being made to carry "no generation yet".

The fix is a variant, not a message: an arm the read can return for an artifact that exists but has not
been initialized, which `backend status` renders as nothing to do rather than as evidence to destroy.
Whoever takes it should check `databaseOwnership`'s `'empty' | 'initialized'` answer first — the write
path already makes this distinction, and the read path should not invent a second vocabulary for it.

## Half two — a classify read rewrites `-shm`, but only when a WAL is in play

Opening a SQLite database rewrites its `-shm` file when the database's header says WAL mode or a `-wal`
file sits beside it, and leaves the sidecar alone otherwise. Opening read-only does not avoid it, and
neither does the main file failing to be a database at all: what decides it is whether SQLite must open
a write-ahead log, not whether it succeeds in reading the database.

Measured on this host with `node:sqlite`, 2026-08-25, opening each case read-only and comparing the
sidecar bytes before and after:

| main file                          | `-wal` beside it | `-shm` rewritten |
| ---------------------------------- | ---------------- | ---------------- |
| not a database                     | yes              | **yes**          |
| not a database                     | no               | no               |
| WAL-mode header                    | no               | **yes**          |
| rollback-journal header            | no               | no               |

This matters because the same branch built a quarantine whose stated purpose is to hand an operator
*preserved* evidence, and made publication prove ownership before it touches an artifact it may not own.
Both take care not to alter what they refuse. The classify read alters it anyway, one sidecar deep — and
it does so on the **ordinary** path, not only after an interrupted move: discard classifies the artifact
before anything is moved, while the `-wal` is still beside it, so every discard of a WAL-carrying journal
rewrites that journal's `-shm` before deciding anything about it. The quarantine's documentation
describes the artifact set as retained without noting that one member of it is reconstructed by the act
of looking.

The observation that started this was weaker than the table above and was nearly written down as the
finding: a test wrote `retained shm` into `<journal>-shm`, ran a discard whose `-shm` move was injected
to fail, and read the sidecar back to find SQLite shared-memory bytes. That end state has more than one
possible writer, and attributing it to "opening the database" would have been wrong — the second row
shows a read with no `-wal` beside it leaving the sidecar untouched. The rewrite belongs to the *first*
classify read, when the `-wal` had not yet moved.

There is probably no fix here, and that is the point: the honest resolutions are to state the constraint
where the quarantine promises preservation, and to decide whether `-shm` belongs in the retained set at
all. It carries no durable content — a `-wal` does, and a main database does — so retaining it may be
costing the appearance of tampering in exchange for nothing.

## Start condition

Either half can be taken alone. Half one is small and self-contained. Half two is a documentation and
scope decision that should be settled before anyone writes a test asserting `-shm` bytes, because such a
test passes or fails on whether a `-wal` was beside the artifact at the last read — which is what
produced the failure above.

## Why deferring is not free

Half one's wrong successor points at a destructive command, and it is harmless today only because a
zero-byte journal is being assumed to be an interrupted creation. That is an assumption about how the
file got there, not something the file says: a journal truncated to nothing — a full disk, a botched
copy — is also zero bytes. A fix that renders zero bytes as "nothing to do" would hide that case exactly
as confidently as today's code tells the operator to destroy it. Whoever takes half one has to decide
which of the two a zero-byte file is claimed to be, and say so in the arm's name.
