# The discuss shutdown-refusal asymmetry round 21 fixed for was never reachable

**Status**: closed — premise disproven, not an open gap.

## What was believed

Round 21's commit (`5d5a2b88`, "fix(discuss): stop the refusal from spinning, and give it a code and an
exit of its own") said reusing `session_not_found` for `commitDecision`'s controller-aborted guard meant
"a bid during a hard drain told an LLM the session did not exist while `discuss status` on the same id
still answered." That belief — an operator-facing asymmetry between a discuss bid and a discuss status
read during a hard drain — justified three additions: a `SESSION_SHUTTING_DOWN`-specific branch of
`discussManagerError` plus a `sessionShuttingDownRemediation` helper (`src/discuss/shell/tools.ts`), and a
`LAUNCH_AND_DOMAIN_RETRY_LATER_ERROR_CODES` entry mapping the code to HTTP 503 and exit 75.

## What is actually true

The asymmetry is unreachable by construction, re-verified against the tree at `5d5a2b88`:

- `runtimeState.setLifecycle('draining')` (`runShutdownSequence`, `src/coordinator/shutdown.ts`) runs
  before any shutdown obligation. `hooks.onShutdown` — the only caller of `clearAllDiscuss`
  (`src/discuss/shell/live-registry.ts`), whose abort-first pass is the only way `commitDecision`'s
  controller-aborted guard can ever fire while the session is still loadable — is a *closing* obligation,
  ordered after the *opening* obligations that include server close.
- `operationalRouteSpecs` (`src/transport/rpc/operational-catalog.ts`) admits no discuss route at all.
  Once draining, both `src/transport/ipc/server.ts` and `src/transport/http/handler.ts` refuse any method
  absent from that catalog with `lifecycleRefusalResult` (`code: 'backend_shutting_down'`) before dispatch
  ever reaches a discuss handler.
- `discuss.session.bid` and `discuss.session.detail` (`src/transport/rpc/catalog.ts`) are both ordinary
  catalog routes with no special drain admission, so a *new* dispatch of either one during a hard drain
  hits the identical refusal — `backend_shutting_down`, exit 75 through `errorCodeToExit`'s direct
  `code === 'backend_shutting_down'` check, independent of `LAUNCH_AND_DOMAIN_RETRY_LATER_ERROR_CODES` —
  before either request ever reaches `commitDecision`. There is no reachable state where a fresh bid and a
  fresh status read on the same session id are answered differently because of a hard drain.

## What this branch did

The operator-facing half was reverted on the same branch that introduced it: the `discussManagerError`
branch and `sessionShuttingDownRemediation` helper are deleted (`discussManagerError` is back to a plain
`domainError(...)` call), and `session_shutting_down` is removed from
`LAUNCH_AND_DOMAIN_RETRY_LATER_ERROR_CODES`. It now gets the same generic-error treatment as every other
`commitDecision` refusal code `submitManualBid`/`submitManualSpeech` can throw — consistent with its
siblings rather than uniquely privileged, not a regression.

What survives, because it is internal and correct on its own regardless of the disproven premise:
`SESSION_SHUTTING_DOWN` itself, `isSilentCommitRefusal` (`src/discuss/shell/persistence.ts`), the
`commitDecision` guard that produces the code, and `runFollowUpTurns`'s non-resuming return
(`src/discuss/shell/flow/followup.ts`) on a tolerated commit refusal — that return closes a real internal
spin (`docs/todo/agent-attempts-ignore-the-session-abort.md`), independent of the asymmetry claim above.

## Interactions

`docs/todo/agent-attempts-ignore-the-session-abort.md` is unaffected: it never claims the disproven
asymmetry, and the facts it depends on (`SESSION_SHUTTING_DOWN` exists, `commitDecision` refuses with it,
`executeAgentAttempt` still does not check the abort signal) are unchanged by this correction.
