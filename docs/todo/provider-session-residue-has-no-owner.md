# TODO — retire the historical provider-residue sweep

**Status**: open for temporary-tool retirement at 0.11.0. The separate on-demand discard finding is resolved by execution retention.

## Current conversation retention

`LifecycleReactor.settleRetention` in `src/jobs/conversation/lifecycle-reactor.ts` settles retention for a job and execution ordinal before the execution ends. Its `discardResidue` method calls the bound provider's residue contract after primary discard, including when no primary handle remains. Managed providers implement that contract through `discardCodexRolloutResidue` in `src/providers/codex/artifacts.ts` and `discardClaudeSessionResidue` in `src/providers/claude/artifacts.ts`. Codex discovers descendant forks and removes leaves before parents; Claude removes the conversation's `tool-results` directory. Residue failures are logged and retention completes, leaving those files for separate cleanup.

`LifecycleReactor.discardConversationArtifacts` in `src/jobs/conversation/lifecycle-reactor.ts`, called by discuss synthesis, now joins the same settlement only for a finishing execution with a committed retention request. It is no longer an independent primary-only discard path. Archive failures become failed retention settlements, recorded by `ExecutionFinisher` in `src/jobs/finishing.ts`; the former discuss callback finding about swallowed fatal artifact errors is closed.

## Unrecorded interrupted-job artifacts

`ConversationManager.recordArtifactHandleAtomic` in `src/jobs/conversation/shell.ts` persists `job.artifact.recorded` for the open execution. The app-server event path records the same event through `createStoreProviderEventEffectPort` in `src/coordinator/services/provider-event-application.ts`. Interrupted app-server recovery does not recover unrecorded handles by parsing stdout or stderr. Residue cleanup can discover descendants from a recorded conversation reference, but artifacts with no usable reference can remain on disk. That undiscoverable residue remains an accepted limitation; recorded handles retain their job and execution ownership.

## Temporary backlog tool

`clients/scripts/sweep-provider-session-residue.mjs` was written for historical stores with a sessions domain. It queries `projection_sessions` and session retention events; those do not exist in the current job-conversation store format. Its automatic store discovery includes current epochs, so the script is not a supported cleanup command against a current installation, even in dry-run mode.

Remove the script at 0.11.0 alongside [`legacy-cli-bundle-name.md`](./legacy-cli-bundle-name.md). Do not adapt it into a second retention owner or add a compatibility reader for the removed sessions domain.

## Start condition

Remove the temporary sweep script with the 0.11.0 release.
