# TODO — terminal wait events cannot report artifact unavailability

**Status**: open, one member.

`recoverJobLocations` in `src/jobs/location-recovery.ts` reads terminal jobs after a crash and calls `JobProgressStore.ensureResultArtifact` before recording their terminal location. Historical result access and the epoch deletion gate use that recorded artifact. The ordinary terminal observer still renders after commit, and a render failure still does not fail the job.

`WaitCoordinator.resultPathFor` in `src/jobs/shell/wait.ts` catches a materialization failure and returns the expected filename. The terminal `WaitStreamEvent` therefore cannot tell a client that the named file was not verified. Make availability a discriminated value in the event, with a materialization failure and retry guidance when no file can be supplied. Keep the terminal outcome independent of artifact availability.

An older CLI requires `resultPath`. Evolve the subscription event additively or at a new protocol generation, so a shipped reader does not silently accept an unavailable artifact as a path. The production `WaitCoordinator` composition already supplies `ensureResultArtifact`; make that requirement explicit in its constructor.

## Start condition

Define the mixed-build event contract and test both current and shipped readers, including a materialization failure after a durable terminal commit.
