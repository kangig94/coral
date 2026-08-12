# TODO — reap the MCP children a codex app-server leaks

**Status**: settled, not planned. Two parts in a fixed order. This document opened on 2026-08-12 with three
options and four unverified premises; every one has since been answered by reading the source, and the answers
are recorded here so nobody re-derives them. What remains is one design choice (where a record lives) and the
implementation itself.

**Upstream**: [openai/codex#30408](https://github.com/openai/codex/issues/30408). A codex app-server spawns MCP
servers per thread and never reaps them. The reporter measured **133 orphaned MCP processes at ~9.3 GB RSS
after 25 threads**. The issue's own root-cause statement is load-bearing for everything below:

> The app-server does not track which MCP processes belong to which thread, and has no lifecycle management to
> kill MCP processes when threads end.

No maintainer response at time of writing. The reporter's workaround is `pkill -P <app-server-pid>`, which also
kills the MCP servers of threads that are still live.

**Why Coral cares**: this is the cause of the wedged-host incident of 2026-08-02 — roughly 93 leaked MCP
children on one host, 253 across four, and the host stopped answering. Provider-host serviceability (PR #300)
made that host evictable without killing the daemon and retired `docs/todo/wedged-app-server-host-eviction.md`.
It did **not** stop the leak, and it does not reclaim the leaked processes on every path. That remainder is
this document.

## The one sentence this work delivers

> A codex host closes on its own when nothing needs it, and closing it takes everything it spawned.

Neither half works alone. Part B alone closes hosts more often on a path that orphans their children — it makes
the leak **worse**. Part A alone reclaims only on explicit operator eviction, which is not automatic. They ship
together, A first.

## Where the leak survives today

| Path | On host teardown, are the MCP grandchildren reaped? |
| ---- | -------------------------------------------------- |
| Proxy-owned host (a routed app-server operation) | **Yes.** Containment signals the process group — `signalPid(-containment.processGroupId)` (`src/infra/process-containment.ts:257`) — which reaches grandchildren without enumerating them. |
| Coordinator-local host | **No.** `gracefulKill` signals only the child (`src/infra/process-supervision.ts:13-23`), and `spawnProviderServerTransport` does not pass `detached` (`src/providers/app-server-transport.ts:203-208`), so the app-server shares Coral's process group and has no group of its own to signal. Its MCP children are orphaned and keep running. |

An operator who evicts a coordinator-local host today frees the host and leaves its leaked MCP behind.

## Part A — give the coordinator-local host its own process group

Spawn it `detached` so it leads its own group, record that group durably, and reap the group on teardown and at
boot.

**There is no second reaper to invent.** This was recorded as A's blocking difficulty and it was wrong.
`reapRecordedContainment` lives in `src/infra/process-containment.ts:312` — shared infrastructure, not
proxy-domain property — and **the coordinator already calls it**, at
`src/coordinator/services/recovery/interrupted-performer.ts:103` (boot recovery) and
`src/coordinator/services/provider-proxy-set-inheritance.ts:327`. The provider proxy is one more caller
(`enforcement.ts:133`), not the owner. Part A adds a caller, not an authority.

The recorded identity shape is already settled by that function:

```ts
{ pid, processStartedAtSeconds, processGroupId }
```

`processStartedAtSeconds` is what makes this safe rather than a guess: if the recorded pid has since been
recycled onto an unrelated process, the start time will not match and nothing is signalled. This is the
identity-based answer to the same question resemblance-based reaping gets wrong.

**Work**:

1. `spawnProviderServerTransport` spawns `detached` (`src/providers/app-server-transport.ts:203-208`).
2. The containment identity is recorded durably at spawn.
3. Teardown reaps through `reapRecordedContainment` instead of the child-only `gracefulKill`.
4. Boot recovery reaps records left by a coordinator that died without tearing down.

**Touches**: `tests/invariants/timeout-kill-escalation.test.ts` and the containment rules in
`.claude/rules/validation.md`. A detached group outlives its spawner by design, so step 4 is not optional —
without it, Part A trades a leak of MCP children for a leak of whole app-servers.

## Part B — let codex hosts retire when they are unpinned

Codex hosts declare `idleRetirement: 'none'` (`src/providers/codex/provider-facets.ts:165`), so
`neverRetiresWhenIdle` keeps them acquisition candidates for the daemon's whole lifetime
(`src/coordinator/live/provider-hosts/idle.ts:55-57`). That is why 8-hour-old threads' MCP servers are still
resident.

**The contract's two values are two gates, and the value codex needs is "no gate".** Read
`canCloseIdleHost` (`src/coordinator/live/provider-hosts/idle.ts:64-88`) in order:

```
pinned                → keep          (base check, applies to everyone)
neverRetiresWhenIdle  → keep          ('none' gate)
retiresOnHostReport   → keep unless the host reports idle   ('host-reported' gate)
otherwise             → close on the idle timer
```

Claude *needs* the `host-reported` gate because its broker multiplexes internally, so Coral's pin count does
not see the broker's own sessions. Codex has no such hidden population: pins are held per unit of work
(`acquireProviderHostPin` at `provider-hosts/index.ts:356` and `:483`, released at `:658`), and releasing the
last one already arms the idle timer for shared hosts. **The machinery is fully wired; one value switches it
off.**

So: extend `idleRetirement` with a third value and give it to codex. The axis the existing two names share is
*who supplies the idleness fact*, so `'coordinator-observed'` fits beside `'host-reported'` and `'none'` —
final name is a plan-time call. The implementation is the **absence** of a gate, not a new mechanism.

### Why this is safe — verified, not assumed

**Host lifetime is orthogonal to thread continuity.** `initializeThread` runs on **every** provider request
(`src/providers/codex/thread-kernel.ts:1317`); there is no path that reuses an in-process thread. Every turn
already issues `thread/start` or `thread/resume` (`:832-860`). Continuity is carried by the persisted
`threadId`, not by the app-server process, and is re-established by RPC each turn whether or not the host
survived in between. Retiring a host therefore changes nothing about thread identity.

**A turn can never be cut.** Retirement requires `activePinCount == 0`, and a pin is held for the duration of
the work. An in-flight turn is not a retirement candidate.

**Resumability is file-based, so this does not interact with artifact retention.** `RetentionPolicy` is
`'retain' | 'discard_provider_artifacts_on_terminal'` (`src/sessions/entry.ts:13-17`), defaulting to `'retain'`
(`src/coordinator/services/job-launch.ts:127`); `src/workflow/launch.ts:125` is the only chooser of discard.
`hasRetentionProtection` (`src/sessions/lifecycle-reactor.ts:1104-1108`) delays discard while `activeJobId` or
a protective continuation lease exists — which is why workflow children stay resumable until the workflow
concludes. That mechanism keeps the **file**, not the host. Either the rollout is on disk and resume works
after retirement, or it is gone and resume fails regardless of host lifetime. See
[`archived-session-restore.md`](archived-session-restore.md) for the separate work of resuming a discarded
session; the two are independent.

*The one behaviour B removes*: if a live app-server can serve `thread/resume` from memory for a thread whose
rollout was already deleted, retiring the host closes that window. That window is an accidental bypass of a
deletion Coral performs deliberately, so closing it is correct.

## Diagnostic — record a disagreement, never act on it

An independent observation is available: "zero codex jobs are live" versus "a codex host still holds pins".
They should agree; a disagreement means a lease was never released, and a leaked pin is exactly what would keep
Part B from ever firing for that host.

**Log the disagreement. Do not close on it.** A pin that looks leaked may be real, and acting on the weaker of
two ledgers to destroy a host is the shape of the wrong-host defect PR #300's fourth review round caught. The
pin count stays the single authority for retirement; the job ledger is a witness that something needs looking
at.

Note for whoever builds this: a job counter is **not** a substitute for the pin count. `attachSession`
(`provider-hosts/index.ts:483`) pins a host without a job, so "zero jobs" does not imply "nothing is attached".

## Barred, with reasons

### Session-scoped reaping — do not attempt

The natural ask — "when a session's turn ends, reap the MCP that session used" — cannot be built on identity,
only on resemblance:

- Coral is never told about MCP processes. The only `mcp` in the codex adapter is `mcpToolCall`
  (`src/providers/codex/thread-kernel.ts:507`), a progress event about a tool call, not a process.
- **codex itself does not know** which MCP belongs to which thread — the upstream issue's own root cause. Coral
  sits outside that process tree and knows strictly less.

Attribution would have to come from cmdline, spawn time, cwd, or parent pid. That is the failure mode PR #300's
fourth review round caught: a repair correlated findings by content signature instead of exact identity, so one
host's finding attached to another host's job. Doing the same to *processes* is worse, because it is automatic
and silent — it would kill an MCP server a live thread is using. The reporter's `pkill -P` has exactly this
defect. `.claude/rules/validation.md` also makes it BLOCKING that containment teardown "uses the identity
recorded by `recordContainment`, **never by walking descendants**."

Parts A and B need no MCP identification at all: Coral closes hosts it recorded, and the OS delivers the group.
A process Coral did not spawn is not in that group and cannot be hit. If upstream ever tracks MCP ownership per
thread and exposes it, this reopens; until then the correct unit is the host.

### Scanning for MCP processes at global quiescence — same defect, later

"When codex job count hits zero, kill every MCP" is a good *trigger* — it picks a moment when nothing can be
misattributed — but implementing it as a process scan reintroduces resemblance-based selection, and Coral's job
ledger says nothing about processes Coral never spawned (a codex the user runs in another terminal, another
daemon, another tool). Routed through host closure instead, the trigger needs no new mechanism: at zero jobs
every host is unpinned, so Part B already retires them all. It is Part B's best case, not a separate feature.

### `idleRetirement: 'host-reported'` for codex — impossible, not merely unwise

`host/stats` is **Coral's own notification**. Its only emitter is Coral's own claude broker
(`src/providers/claude/appserver/broker-pool.ts:332`), declared in Coral's own broker protocol
(`src/providers/claude/appserver/protocol.ts:167`). The codex app-server is an external binary and does not
send it.

Setting codex to `'host-reported'` therefore leaves `entry.hostStats` permanently `null`, so
`isHostIdleFromStats` is always false (`idle.ts:61`), so `maybeArmIdleTimer` returns early (`:107`) and
`canCloseIdleHost` refuses (`:78`) — **the host never retires**, identically to `'none'` but through a
declaration that reads as though retirement works.

`'none'` is therefore the honest declaration, not an oversight. Both values were chosen in the same commit
`e48a8ed2` (#296), one per provider, matching each provider's actual signal.

### One host per job — disproportionate

Making codex hosts `job-exclusive` would make host teardown coincide with session teardown. It buys what
Part B buys, at one app-server process per job, full startup cost per job, and no shared-session reuse.

## Open

- **Where the coordinator-local containment record lives.** The proxy carries it on the provider-operation
  carrier record, but a coordinator-local host is not an operation. The host inventory introduced by PR #300
  (`src/providers/host-inventory-schema.ts`) is the leading candidate. This is the one design decision Part A
  still needs.
- Whether an orphaned MCP server exits on its own when its stdio closes. Implementation-dependent; the
  2026-08-02 observation (93 children under a *live* app-server) says nothing about the orphaned case. Parts A
  and B do not depend on the answer.
- Whether upstream has any configuration mitigation today. The issue proposes a shared/reuse mode with an idle
  timeout, which reads as a proposal rather than an existing option.

## Do not re-derive these

- The proxy reaps by process group and the coordinator-local path does not — `process-containment.ts:257`
  against `process-supervision.ts:13-23` and the spawn options at `app-server-transport.ts:203`.
- `reapRecordedContainment` is `infra/`, and the coordinator is already one of its callers.
- Coral receives no protocol information about MCP processes; `mcpToolCall` is a progress event.
- `host/stats` is Coral's own claude-broker notification; codex never sends it.
- `initializeThread` runs every request, so no thread lives in an app-server across Coral's view of it.
- `attachSession` pins a host without a job.
- Killing an app-server terminalizes its jobs correctly, and app-server jobs are preserved rather than
  terminalized when a host dies mid-turn — the next boot's recovery finalizes them. Carried forward from the
  retired wedged-host TODO, verified by reading and confirmed by the 2026-08-02 manual remedy.
- Host identity includes `cwd`, so "only project X is affected" is never evidence of a project-specific cause.

## Interim mitigation

Evict the affected host rather than restarting the daemon:

```
coral-cli backend provider-host list
coral-cli backend provider-host inspect <ph1.…>
coral-cli backend provider-host evict <ph1.…>
```

For a proxy-owned host this reclaims its MCP children with it. For a coordinator-local host it frees the host;
the orphaned MCP servers must still be cleaned up by hand until Part A lands. Watch for growth with:

```
ps -eo pid,ppid,rss,args | grep -E 'codex app-server|mcp'
```

A host carrying tens of MCP children is the leading indicator.
