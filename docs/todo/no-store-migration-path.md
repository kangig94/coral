# TODO — a DDL change destroys the store, because there is no migration

**Status**: open, unscheduled. Recorded 2026-09-12 while designing
[`store-reset-bound-promoted-to-a-boot-refusal.md`](store-reset-bound-promoted-to-a-boot-refusal.md),
which is damage control around this. Fixing the quarantine does not fix this.

## The fact

`classifyStoreFormat` in `src/store/db.ts` has exactly one non-destructive outcome for a store carrying
version metadata:

| Observation | Result |
| --- | --- |
| stored product version newer than current | `newer-incompatible` — refuse |
| stored fingerprint equals current | `compatible` |
| stored product version older than current | `older-incompatible` — **automatic reset** |
| versions equal, fingerprints differ | `corrupt-or-unsupported` — **automatic reset** |

`legacy-adoptable` is not a migration: it requires version metadata to be **absent** *and* the fingerprint
to match, which is a rewrite-era adoption of a store that predates the version key.

The fingerprint is a hash over the DDL. So **any release whose `src/store/schema.sql` changes destroys
every existing store on upgrade**, with no path that carries the data forward. Measured on 2026-09-12:
9 commits have touched `src/store/schema.sql`, against 33 release tags. Roughly one release in four is a
guaranteed total loss of jobs, sessions, journal and KB projection history.

Nobody notices, because the reset is silent, automatic, and — until a store crosses 1 GiB — always
succeeds. The incident that exposed it was a *reporting* limit failing, not the reset.

## Why this is not the quarantine's problem to solve

Quarantine preserves the bytes. It cannot make them readable: a quarantined store is
`older-incompatible` for the build that quarantined it, by construction. Reading it requires installing
the matching older Coral. That is a real exit for the one person who maintains this repository, and no
exit at all for anyone else — Coral's end user does not install old builds, and the model that reads the
CLI output for them cannot either.

So preservation buys an audit trail and a manual recovery, not continuity.

## What the shape of a fix would have to answer

- **What a migration is addressed by**, given §10. The fingerprint is derived from the DDL, so a
  migration cannot be keyed on it without the key changing underneath the migration. A separate,
  monotonic schema generation with its own owner is the candidate, with the fingerprint retained as the
  integrity check rather than as the version.
- **Which direction is supported.** Forward-only migration still leaves a rollback meeting a store it
  cannot read — today that is `newer-incompatible`, which refuses rather than destroys, and that refusal
  is correct and must stay.
- **What happens to a migration that fails halfway**, on the startup path, where a throw is an unbootable
  coordinator. The rule from the quarantine work applies unchanged: every observation selects a
  mechanism, never a refusal.
- **Whether every DDL change needs one.** Many are additive — a new table, a new nullable column — and
  additive changes are exactly what a tolerant reader survives. The fingerprint does not distinguish
  additive from destructive, so it reports every change as fatal. Distinguishing them may be most of the
  fix.

## Not the same entry as `store-format-routing.md`

[`store-format-routing.md`](store-format-routing.md) is the sibling half and the two do not close
together. It asks how an **older** build finds and opens a store in its own format — a layout question,
answered by keeping more than one store. This asks how a **newer** build carries an older store's data
forward — a transformation question, answered by changing one store in place. Fingerprint-keyed routing
would let both builds run without either destroying the other's store, and would still leave every
upgrade starting from nothing.

## What to do in the meantime

Nothing here blocks a release. But a release that changes `src/store/schema.sql` should say so in its
notes, because today it reads as an ordinary patch and is not one.
