# TODO — `writeAtomicDurableSync` overloads a lost race and a durability failure

**Status**: deferred. This predates the store-epoch work and has fourteen production call sites, so changing the
storage port is outside Round 43's owner-approved scope.

`writeAtomicDurableSyncNode` returns `false` for two failures with different dispositions:

- an `ENOENT` while writing or renaming the temporary file, which can mean another actor removed a private
  in-progress artifact and the caller may be able to retry; and
- failure to open or sync the parent directory after the rename landed, which means the published name is present
  but its directory entry was not proven durable and must fail closed.

The boolean does not tell a caller which state occurred. A future change should replace it with a result whose
variants name those outcomes, then migrate the KB, provider-proxy, coordinator, store, and engine callers according
to the disposition each one owns. It must not turn directory-sync failure into a retry.

This is the storage-port member of the same answer-shape class as
[`process-port-answers-with-two-values.md`](./process-port-answers-with-two-values.md) and
[`provider-operation-last-error-overloads-two-dispositions.md`](./provider-operation-last-error-overloads-two-dispositions.md).

Round 43 leaves the port unchanged and separates the outcomes only in `registerStoreEpochHolder`, where the UUID is
private to the process and the published path can be observed after `false`. It permits two total publication
attempts. A post-ready sweep reads one directory snapshot, so after it removes the first UUID's temporary file it
cannot also discover the fresh retry UUID. Losing both attempts therefore requires distinct or systematic
interference rather than the single race being repaired; exhaustion keeps the existing boot refusal as the named
successor.
