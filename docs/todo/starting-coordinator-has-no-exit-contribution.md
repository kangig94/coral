# A starting coordinator contributes no exit code of its own

**Status**: open. The text is decided; the exit contribution is not.

## What is wrong

`BACKEND_STATUS_EXIT_CODES` (`src/cli/commands/backend.ts`) is keyed by the **outer** probe status, so an
authenticated coordinator that answers health scores `ok` and exits 0 whether its own snapshot says `ok` or
`starting`. The reader of this surface is an LLM that branches on `$?`; a coordinator that answered but is
not ready is indistinguishable from a ready one by exit code alone, so work dispatched on that 0 meets a
coordinator that cannot serve it yet.

## Start condition

Start after the owner decides whether an answered-but-not-ready coordinator earns its own exit contribution,
and what a caller is expected to do with it — retry, wait, or proceed. The decision belongs with the other
exit contributions composed at the `backend status` call site rather than in the inner health projection,
which no longer rewrites anything.
