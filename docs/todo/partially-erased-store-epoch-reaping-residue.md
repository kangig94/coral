# Partially erased store-epoch reaping residue

**Status**: open, out of scope for store-reset Round 42.

`removeAbandonedStoreDirectory` in `src/store/epoch.ts` can prove that a residue directory is contained
while finding its `.lock` absent. A non-recursive `rmdir` safely reclaims the empty pre-lock construction
case because it fails if any entry appears before removal.

A partially erased `.reaping-<uuid>` directory is different. If its `.lock` was already unlinked while
other entries remain, the same `rmdir` fails with `ENOTEMPTY`; there is then no lock through which the
sweep can establish exclusive ownership, so the directory remains `unobservable`. Reclaiming that shape
needs its own ownership argument and must not widen the empty-directory removal into a recursive delete.

The same missing pre-lock ownership fence also limits writer progress under repeated external removal;
see [`store-epoch-minting-under-sustained-external-interference.md`](./store-epoch-minting-under-sustained-external-interference.md).
