# TODO — give the KB daemon an enforcer outside its own process

**Status**: open. Scoped on 2026-08-14 after a production KB daemon survived a graceful coordinator SIGTERM —
reparented to init, unresponsive to SIGTERM, cleared only by SIGKILL. The immediate defect is fixed; the
guarantee behind it is not, and this document is the part deliberately left out.

## What was fixed, and what it actually claims

The daemon had five stop triggers — parent watchdog, stdin `shutdown` request, stdin `end`, SIGTERM, SIGINT —
funnelling into one `stop()` behind a single `settled` latch. The first arrival ran the cleanup and the other
four became no-ops. Cleanup itself awaited `kbWriteHost.dispose()` with no bound. Five detectors, no enforcer.

`createKbDaemonTerminalWindowAuthority` (`src/kb-daemon/daemon-main.ts`) added the missing half: the first stop
request opens a window that no later arrival can extend or disarm, cooperative disposal is aborted partway
through it, and the process exits at its close.

**That bounds every stop in which the event loop still turns** — including the production case, whose SIGTERM
handler did run and found the stop already latched.

**It is not a guarantee, and must not be described as one.** The timers are in the same event loop as the
teardown they police. A loop blocked synchronously never reaches them. That is not hypothetical: curate can
reach `git merge-file` through `execFileSync` with no timeout (`src/kb/curate/frontmatter-merge-driver.ts`),
and while the main thread sits in `spawnSync`, no watchdog tick, no stdin `end`, and no signal handler runs.

## The shape the guarantee actually needs

An enforcer that is not the coordinator and not the daemon. Both candidate owners share one failure mode:
whoever owns the guarantee can die first. Parent-local escalation dies with the parent —
`gracefulKill` schedules its SIGKILL in the coordinator's own event loop
(`src/infra/process-supervision.ts:13-23`), so a coordinator that exits destroys the escalation before it
fires. Child-local escalation, which is what shipped, fails when the child's loop is what wedged.

Coral already runs this pattern correctly once. The provider guardian/reaper hold a deadline that survives
coordinator loss, latch before awaited teardown, report scheduling lateness rather than pretending the bound
was met, and confirm containment _absence_ rather than trusting leader exit
(`src/provider-proxy/enforcement.ts`, `src/provider-proxy/orphan-deadline.ts`).

A design exploration on 2026-08-14 proposed generalising that semantic core into a `src/leased-containment/`
domain and having KB depend on it: a process containment may exist only under an authenticated coordinator
tenancy, and an untransferred tenancy makes the containment irreversibly terminal by a precomputed absolute
deadline. Its conclusions worth keeping:

- **Do not import `provider-proxy/orphan-deadline.ts` from KB.** It carries provider-specific timing, pairing,
  protocol and successor policy. Depending on it would make `provider-proxy/` a second, falsely named home for
  generic process lifetime and invert the layering the invariants enforce.
- **Do not copy it either.** One concept, two homes, guaranteed drift.
- **`prctl(PR_SET_PDEATHSIG)`, cgroups, launchd jobs and native addons are ruled out** — they would make the
  guarantee depend on a different mechanism per host, which the no-per-OS-divergence rule forbids outright.

One claim from that exploration was **over-read and should not be carried forward**: that the first transition
is blocked because a successor cannot attach to an already-running old-build daemon, making the design
incompatible with the hot-upgrade rule. Restarting the _KB daemon_ during an upgrade is not a cold upgrade of
Coral. The constraint binds the coordinator's own continuity, not this child's.

## Also open, found in the same audit

Each is real and independently verified from source; none is a survival bug once the daemon bounds its own
teardown, which is why they were left out rather than folded in.

- **Detached grandchildren are not covered by anything.** `runtime.process.exec` spawns each child into its own
  process group (`src/runtime/real.ts:364-382`, `src/runtime/exec-builder.ts:88-96`) with no containment
  recorded, so uv, Marker and curl/wget children can be stranded — and a daemon that now exits _faster_ makes
  stranding more reachable, not less. Covering them means the containment authority must own or gate the spawn
  through the runtime process port; a wrapper that registers after `spawn` still has an execution race. Until
  that exists, the claim is bounded to the daemon's own process and calling it "KB containment" would be false.
- **Coordinator shutdown can skip asking the daemon to stop at all.** `shutdown.ts` wraps KB disposal in
  `runBudgetedStep`, and `withBudget` skips the task outright when the drain budget is exhausted — while the
  immediately preceding `recovery coordinator teardown` is unbudgeted and can consume it. Converting it to
  `runRequiredBudgetedStep` is _not_ the fix: on exhaustion that path fires the task with an already-aborted
  signal on the argument that its synchronous prefix has run, and here the stdin write lives inside an async
  `runExclusive` turn, so nothing would be sent either way — it would trade a silent skip for a shutdown error.
- **Recovery teardown is itself unbounded**, and it is what exhausts that budget:
  `src/coordinator/services/recovery/index.ts` aborts finalizations and then unconditionally awaits every
  commit-started promise with no timeout.
- **Liveness is policed rather than derived.** `daemon-main.ts` installs `setInterval(() => undefined, 60_000)`
  purely to pin the event loop, so the process can outlive the parent pipe and then relies on a poll to notice.
  The stdin `data` listener already references the loop, which makes the keepalive close to redundant; removing
  it would make parent EOF structurally sufficient. Left alone deliberately — `stopAsync` clears it _before_
  the disposal await, so it was not what held the stranded daemon open, and changing it would be an unrelated
  behavioural risk riding along with a fix.
- **No test kills a coordinator and asserts the daemon disappears.** The runtime-host tests release their
  mocked work before awaiting disposal and the supervisor tests emit `close` by hand, so every existing
  assertion is about the happy path. The gap is process-level by nature and needs a process-level test.
