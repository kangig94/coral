# TODO — evict a wedged app-server host

**Status**: open, deliberately deferred. Not scoped; the fix requires a contract
decision that has not been made.

**Rarity**: observed once, 2026-08-02, after roughly four hours of heavy
delegation. It needs an unresponsive-but-alive provider host, which is not a state
Coral can cause on its own. Low frequency, high nuisance when it happens.

**Severity after 0.10.4**: an affected job can now be aborted, so nothing is
permanently stuck. What remains is that the next job may hit the same host, so the
practical remedy is still a daemon restart.

## Symptom

Jobs sit at `running` with no progress events. `coral-cli wait` replays to the same
cursor forever and reports the same elapsed time on every attempt. Exports are
absent. `coral-cli abort jobs <id>` reports success — genuinely, not falsely — and
before 0.10.4 nothing terminalized. Only one project is affected at a time: host
identity includes `cwd` (`hostKeyFromSpec`,
`src/coordinator/live/provider-hosts/state.ts:46`, hashes `cwd` alongside
provider/command/args/env), so other projects keep working and the failure looks
project-specific when it is not.

## Mechanism (verified by reading source, 0.10.4)

1. **The provider host stops answering while its process stays alive.** In the
   observed case the cause was outside Coral: `codex app-server` had accumulated
   ~93 leaked MCP child processes on that host (253 across four hosts, ~6.5 GB
   RSS). Each codex session spawns its MCP servers and they are never reaped. That
   is a codex defect, not a Coral one.

2. **Nothing in Coral bounds a codex app-server RPC.** `provider-hosts/lease.ts`
   exposes `rpc: (method, params) => handle.rpc.request(method, params)` — no
   timeout, no `AbortSignal`. Compare the Claude app-server path, which bounds
   every control request at 60 s
   (`src/providers/claude/appserver/print-controller.ts`,
   `DEFAULT_CONTROL_REQUEST_TIMEOUT_MS`). The asymmetry is real: codex has no
   transport-level bound at all.

3. **A pending request pins the host, so the idle reaper cannot retire it.**
   `acquireProviderHostPin` / `activePinCount` gate `canCloseIdleHost`
   (`src/coordinator/live/provider-hosts/idle.ts`).

4. **Even unpinned, a codex host is never idle-retired.** Codex hosts are
   `leaseMode: 'shared'` (`src/providers/codex/execution-plan.ts`) with
   `idlePolicy: 'daemon'` (`src/providers/codex/provider-facets.ts`).
   `hasDaemonLifetime(entry)` therefore makes `canCloseIdleHost` return `false`
   and makes `maybeArmIdleTimer` clear the timer outright
   (`provider-hosts/idle.ts`). The entry keeps `closingError === null` and
   `handle.isClosed() === false`, so it remains an acquisition candidate for the
   daemon's whole lifetime.

5. **Abort is bounded but does not evict.** 0.10.4 added
   `ABORT_CONFIRMATION_DEADLINE_MS` to `finishAbortedStart`
   (`src/providers/codex/thread-kernel.ts`): once an operator asks to cancel, the
   kernel waits a fixed interval for confirmation and then terminalizes locally as
   `signal_abort`, preserving the recovery snapshot. That frees the job. It does
   not close, evict, or mark the host, so step 4 still holds and the next launch
   can attach to the same host.

Net: **the loop is `launch → hang → abort → launch → hang`**, and the operator's
real remedy is a daemon restart.

## Why this is not a one-line fix

The obvious move — have the kernel report the host fatal so
`closeProviderServerEntry` runs — is not available. `closeProviderServerEntry` is
**private** to `ProviderHostManager` (`src/coordinator/live/provider-hosts/index.ts`),
and the kernel holds only `AppServerSession = { rpc, subscribe, closed, interrupt }`.
The provider contract says so on purpose: *"Provider-facing session. Process
ownership and release remain capability-private."* (`src/providers/contract.ts`).

So eviction needs either a contract addition or a coordinator-layer owner. That is
the decision to make, and it is why this is a TODO rather than a patch.

## Options, with the tradeoff that actually decides it

**A. Widen the provider-facing contract** — add something like
`reportUnresponsive(reason)` to `AppServerSession`, called by the kernel when its
abort deadline expires.
*For*: the kernel is the only component that knows a turn went unanswered.
*Against*: puts a lifecycle capability into a contract that deliberately withholds
process ownership, and every provider then has to be trusted with it.

**B. Coordinator-layer eviction** — the execution service observes an
abort-by-deadline outcome (already distinguishable: `signal_abort` reached through
the deadline branch rather than a confirmed interrupt) and asks the host manager to
close that `HostRef`.
*For*: keeps ownership where it is; no contract change; one owner decides.
*Against*: the coordinator must learn *which* host, so the deadline outcome has to
carry the `HostRef` — a plumbing change through the terminal path.

**C. Bound the transport instead** — give codex's `rpc` a timeout the way Claude's
control requests have one, and let an expired request close the host through the
existing failure path (`detachProviderServer` → `rejectPendingProviderRequests`,
`src/coordinator/live/provider-server-transport.ts`).
*For*: removes the asymmetry with Claude, fixes the cause rather than the symptom,
and reuses a path that already works — killing the host process was verified to
terminalize its jobs correctly.
*Against*: requires a policy answer Coral has so far refused to give — how long a
legitimate turn may take. A wrong number kills real work. Note the 0.10.4 abort
deadline was written specifically to *avoid* needing this answer.

**D. Health-based retirement** — keep `idlePolicy: 'daemon'` but let a host that
has failed to answer N consecutive requests stop being an acquisition candidate,
without killing it.
*For*: no policy about turn duration; a poisoned host simply stops receiving new
work, which is the specific harm.
*Against*: needs a definition of "failed to answer" that does not itself require a
timeout, so it may collapse into C.

**Recommendation if picking cold: B or D.** Both leave ownership where the contract
puts it and neither requires deciding how long a turn may run. C is the most
principled but carries the one decision this codebase has consistently declined to
make.

## Do not re-derive these

- Killing the host process **does** terminalize its jobs correctly:
  `child.on('close')` → `detachProviderServer` → `rejectPendingProviderRequests`
  rejects every pending RPC (`provider-server-transport.ts`). Verified by reading;
  also the manual remedy used on 2026-08-02.
- App-server jobs are **preserved, not terminalized**, when a host dies mid-turn —
  they stay live for the next boot's recovery to finalize. That is why killing the
  host did not immediately clear the five stuck jobs; the next daemon start did.
- `coral-cli abort` was never lying. `formatAbortResult`
  (`src/cli/format/jobs.ts`) prints ids only from `result.aborted`, and
  `abortJobs` (`src/coordinator/composition/job-control.ts`) fills that only when a
  registry actually claimed the id. The signal reached a live `AbortController`;
  nothing could act on it.
- Host identity includes `cwd`, so the blast radius is one project. Do not read
  "only project X is broken" as evidence of a project-specific cause.

## Unverified

- Whether the codex MCP leak has an upstream fix or a configuration mitigation. Not
  investigated.
- Whether a host can become unresponsive for any reason other than provider-side
  resource exhaustion.
- Whether `activeTurns` / `liveControllers` host stats (`readHostStats` in
  `provider-hosts/idle.ts`) could serve as the "failed to answer" signal option D
  needs. They are read from provider notifications, so a mute host may simply stop
  updating them — which might be exactly the signal, or might be indistinguishable
  from idle. Worth checking first if D is chosen.

## Interim mitigation

Restart the daemon (`coral-cli backend shutdown`, then any command that starts it).
Watch for growth with:

```
ps -eo pid,ppid,rss,args | grep -E 'codex app-server|mcp'
```

A host carrying tens of MCP children is the leading indicator. On 2026-08-02 the
worst host had 101.
