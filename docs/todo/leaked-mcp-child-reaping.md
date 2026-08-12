# TODO — reap the MCP children a codex app-server leaks

**Status**: open, not scoped. The upstream defect is confirmed and unfixed; what Coral should do about it needs
a decision, and one of the two viable options rests on an unverified premise.

**Upstream**: [openai/codex#30408](https://github.com/openai/codex/issues/30408). A codex app-server spawns
MCP servers per thread and never reaps them. The reporter measured **133 orphaned MCP processes at ~9.3 GB RSS
after 25 threads**. The issue's own root-cause statement is the load-bearing fact for everything below:

> The app-server does not track which MCP processes belong to which thread, and has no lifecycle management to
> kill MCP processes when threads end.

No maintainer response at time of writing. The reporter's workaround is `pkill -P <app-server-pid>`, which
also kills the MCP servers of threads that are still live.

**Why Coral cares**: this is the cause of the wedged-host incident of 2026-08-02 — roughly 93 leaked MCP
children on one host, 253 across four, and the host stopped answering. Provider-host serviceability (PR #300)
made that host evictable without killing the daemon, and retired
`docs/todo/wedged-app-server-host-eviction.md`. It did **not** stop the leak, and it does not reclaim the
leaked processes on every path. That remainder is this document.

## What PR #300 already does, and does not do

| Path | On host teardown, are the MCP grandchildren reaped? |
| ---- | -------------------------------------------------- |
| Proxy-owned host (a routed app-server operation) | **Yes.** Containment signals the process group — `signalPid(-containment.processGroupId)` (`src/infra/process-containment.ts:257`) — which reaches grandchildren without enumerating them. |
| Coordinator-local host | **No.** `gracefulKill` signals only the child (`src/infra/process-supervision.ts:13-23`), and `spawnProviderServerTransport` does not pass `detached` (`src/providers/app-server-transport.ts:203-208`), so the app-server shares Coral's process group and has no group of its own to signal. Its MCP children are orphaned and keep running. |

So today an operator who evicts a coordinator-local host frees the host and leaves its leaked MCP behind.

## The decision this needs

### Session-scoped reaping is not safely buildable. Do not attempt it.

The natural ask — "when a session's turn ends, reap the MCP that session used" — cannot be built on identity,
only on resemblance:

- Coral is never told about MCP processes. The only `mcp` in the codex adapter is `mcpToolCall`
  (`src/providers/codex/thread-kernel.ts:507`), a progress-rendering event about a tool call, not a process.
- **codex itself does not know** which MCP belongs to which thread — that is the upstream issue's own root
  cause. Coral sits outside that process tree and knows strictly less.

Attribution would therefore have to come from cmdline, spawn time, cwd, or parent pid. That is exactly the
failure mode PR #300's fourth review round caught: a repair correlated serviceability findings by RPC content
signature instead of exact host identity, so one host's finding attached to another host's job and the
operator was told to evict a healthy host. Doing the same to *processes* is worse, because it is automatic and
silent: it would kill an MCP server a live thread is using. The reporter's `pkill -P` workaround has precisely
this defect.

It is also barred outright. `.claude/rules/validation.md` makes it BLOCKING that containment teardown "uses the
identity recorded by `recordContainment`, **never by walking descendants**."

If upstream ever tracks MCP ownership per thread and exposes it, this reopens. Until then, the correct unit is
the host, not the session.

### Option A — give the coordinator-local host its own process group, and reap the group

Spawn it `detached` so it leads its own group, record that group the way the proxy already records its
containment, and reap the group on teardown.

*For*: the proxy path already proves the shape, so this is applying one existing discipline to the second
owner rather than inventing anything. It enumerates no descendants, guesses no identity, and reaches
grandchildren by construction. Eviction, idle retirement, host death, and daemon shutdown all then reclaim
that host's MCP.

*Against*: it changes process ownership for the coordinator-local path, which touches
`tests/invariants/timeout-kill-escalation.test.ts` and the containment rules in `.claude/rules/validation.md`.
A detached group also outlives its spawner by design, so the failure mode inverts: a group that is recorded
but never reaped becomes a leak of its own. The proxy answers that with recorded identity plus a reaper; the
coordinator-local path would need an equivalent, and inventing a second reaper is precisely the kind of
duplicate authority this codebase keeps deleting.

*Does not solve*: accumulation while a host stays alive. A long-lived host still grows.

### Option B — let codex hosts retire when idle

Codex hosts are `leaseMode: 'shared'` with `idleRetirement: 'none'`
(`src/providers/codex/provider-facets.ts:165`), so `neverRetiresWhenIdle` keeps them acquisition candidates
for the daemon's whole lifetime (`src/coordinator/live/provider-hosts/idle.ts:55-57`). That is why 8-hour-old
threads' MCP servers are still resident.

The contract already has the other mode: `idleRetirement: 'host-reported' | 'none'`
(`src/providers/contract.ts:145`), and `readHostStats` reads `activeTurns` / `liveControllers` from provider
notifications to judge idleness (`src/coordinator/live/provider-hosts/idle.ts:21-29`).

*For*: switching codex to `'host-reported'` bounds accumulation by the idle window instead of by daemon
lifetime, with no new mechanism and no attribution. **Combined with Option A it is the closest thing to the
"Coral cleans up by itself" outcome that is actually available** — not per session, but automatic and
periodic.

*Against*: **the premise is unverified.** Nothing in the source records why `'none'` was chosen. If it is
deliberate — session continuity across turns, app-server start cost, or a provider-side reason — flipping it
regresses something real. Establish that before building. Note also that PR #300's own analysis found host
stats come from provider notifications, so a mute host may simply stop updating them; that is fine for
retiring an idle host but must not be read as evidence of anything else.

### Option C — one host per job

Make codex hosts `job-exclusive`, so host teardown coincides with session teardown and Option A's group reap
becomes session-scoped for free.

*For*: it converts an unsolvable attribution problem into a solved teardown problem.

*Against*: one app-server process per job instead of one per working directory, paying full startup cost per
job and losing shared-session reuse. Recorded here for completeness; the cost looks disproportionate to the
problem.

**Recommendation if picking cold**: verify Option B's premise first, since it is cheap and decides whether B
is available at all. Then A, because it makes eviction actually reclaim resources and is a discipline this
repository already owns. A and B compose; C is the fallback only if B turns out to be barred.

## Do not re-derive these

- The proxy reaps by process group and the coordinator-local path does not — verified by reading
  `process-containment.ts:257` against `process-supervision.ts:13-23` and the spawn options at
  `app-server-transport.ts:203`.
- Coral receives no protocol information about MCP processes; `mcpToolCall` is a progress event.
- Killing an app-server terminalizes its jobs correctly, and app-server jobs are preserved rather than
  terminalized when a host dies mid-turn — the next boot's recovery finalizes them. Carried forward from the
  retired wedged-host TODO, where it was verified by reading and confirmed by the 2026-08-02 manual remedy.
- Host identity includes `cwd`, so "only project X is affected" is never evidence of a project-specific cause.

## Unverified

- Why codex hosts are `idleRetirement: 'none'`. This gates Option B entirely.
- Whether an orphaned MCP server exits on its own when its stdio closes. Implementation-dependent, and the
  2026-08-02 observation — 93 children accumulating under a *live* app-server — says nothing either way about
  the orphaned case.
- Whether upstream has any configuration mitigation today. The issue proposes a shared/reuse mode with an idle
  timeout, which reads as a proposal rather than an existing option.
- Whether a detached coordinator-local group can reuse the proxy's recorded-containment reaper without
  granting the coordinator a second, parallel containment authority.

## Interim mitigation

Evict the affected host rather than restarting the daemon:

```
coral-cli backend provider-host list
coral-cli backend provider-host inspect <ph1.…>
coral-cli backend provider-host evict <ph1.…>
```

For a proxy-owned host this reclaims its MCP children with it. For a coordinator-local host it frees the host;
the orphaned MCP servers must still be cleaned up by hand. Watch for growth with:

```
ps -eo pid,ppid,rss,args | grep -E 'codex app-server|mcp'
```

A host carrying tens of MCP children is the leading indicator.
