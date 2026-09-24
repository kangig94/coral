# TODO — on-demand provider session discard leaves residue

**Status**: partly implemented. Retention discards provider residue; on-demand discard and retirement of the temporary backlog tool remain open.

## Remaining on-demand gap

`LifecycleReactor.enforceRetention` in `src/sessions/lifecycle-reactor.ts` calls `discardSessionResidue` after the primary discard, including when no primary handle remains. Managed providers implement the contract through `discardCodexRolloutResidue` in `src/providers/codex/artifacts.ts` and `discardClaudeSessionResidue` in `src/providers/claude/artifacts.ts`. Codex discovers descendant forks and removes leaves before parents; Claude removes the conversation's `tool-results` directory. Residue failures are logged and retention completes, leaving those files for separate cleanup.

`LifecycleReactor.discardSessionArtifacts` in `src/sessions/lifecycle-reactor.ts` is the on-demand path used by discuss synthesis. It does not call `discardSessionResidue`: a concurrent resume can create a new fork descended from the same conversation while the walk runs. Before adding residue discard here, establish an exclusion that remains effective through the walk. Keep the on-demand path's fatal artifact invariants; [`comment-sweep-bug-ledger.md`](./comment-sweep-bug-ledger.md) records the discuss finalization catch that currently reduces them to warnings.

## Temporary backlog tool

`clients/scripts/sweep-provider-session-residue.mjs` reclaims residue left by sessions whose retention completed before the discard contract shipped. It is a temporary tool due for removal at 0.11.0. The script defaults to a dry run and requires `--apply` for deletion. Keep this removal visible alongside [`legacy-cli-bundle-name.md`](./legacy-cli-bundle-name.md) in the 0.11.0 release work.

## Start condition

On-demand discard needs a resume-exclusion design before residue deletion can be added. Remove the sweep script with the 0.11.0 release.
