# TODO — give job exports a retention owner and a restore path

**Status**: open for two ordered decisions. Epoch deletion now requires an independently readable result, but no policy expires exported results.

`createStaleJobCleanupPolicy` in `src/coordinator/lifecycle.ts` removes `progressStore.jobDir(jobId)` and the durable CLI metadata row when a terminal scratch artifact is old or from an older bundle. `jobsDir` in `src/jobs/paths.ts` places that scratch under the system temporary root. Exported results and archived provider artifacts live under `runtime.paths.coral.exports.jobsRoot`, a separate tree. The scratch policy does not prune that tree, and no export-prune owner is established.

The epoch closure gate in `src/jobs/location-index.ts` protects result availability while a superseded store may be deleted. It does not set an expiry for user content. Decide whether `CORAL_JOBS_RETENTION_DAYS` includes exports or whether exports get their own policy, whether terminal state is required before pruning, and whether archived provider artifacts share the result's lifetime. Update the operator documentation with that decision.

Coral preserves a provider session file before removing the provider's native copy, avoiding pollution of the provider's interactive resume picker. There is still no restore command that places a preserved file back. Restore must follow the export-lifetime decision so its re-created file has a clear owner and end. It also needs a user-facing identity and a collision rule when the provider already has the same session id.

## Start condition

Set export retention first, then design archived-session restore. The retained-result gate is not a substitute for either decision.
