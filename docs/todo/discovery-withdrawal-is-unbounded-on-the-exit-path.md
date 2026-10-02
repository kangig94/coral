# TODO — remove synchronous discovery withdrawal from the last exit step

**Status**: open. A current-build sentinel provides an outside observer, but the finalizer still performs synchronous filesystem calls before requesting exit.

`finalizeStoppedLifecycle` in `src/coordinator/lifecycle.ts` publishes the shutdown remainder, then calls `removeBackendInfoIfOwner` before invoking `onFinalized`. `removeBackendInfoIfOwner` in `src/infra/backend-discovery.ts` reads and unlinks discovery records synchronously. A blocked filesystem call cannot be interrupted by that coordinator's own timer or abort signal. `watchChild` in `src/coordinator-launch/child-watch.ts` can supervise an unresponsive current-build child, but it cannot make a kernel-blocked filesystem operation return.

The writer can stop withdrawing the record and make readers expire it, as the socket binder already does for stale socket paths. That needs a shared stale-record disposition for `backend status`, `backend shutdown`, and expansion; [`missing-discovery-record-disposition.md`](./missing-discovery-record-disposition.md) tracks their current disagreement. Or withdrawal can move to a separately bounded operation whose completion does not precede the exit request. Delegating only the remainder write does not help while the withdrawal that follows still blocks on the same device.

## Start condition

Choose writer withdrawal or reader expiry, then prove that the finalizer can request exit without awaiting an uninterruptible discovery operation. Preserve the owner-token check so a departing coordinator cannot remove a successor's record.
