# TODO — every way Coral ends a process runs on that process's own event loop

**Status**: open, unobserved. Recorded on `fix/workflow-replacement-cleanup-envelope` because it was noticed
while reasoning about macOS containment, not because anything failed.

## What exists now

`IdleTimer` (`src/coordinator/live/idle.ts`) polls every 60s and drains after `DEFAULT_IDLE_TIMEOUT_MS`
(`:5`, six hours) of no inflight work. It is the coordinator's only unattended exit.

It runs on the coordinator's own event loop, through `TimePort.setInterval`. So does the shutdown budget, so
does every finalizer it contains, and so does a proxy set's orphan deadline inside its own roles.

## The gap

**Every self-termination path Coral has is scheduled by the process it is meant to end.** A coordinator whose
loop stops turning — a synchronous stall, an await chain that never settles — cannot reach any of them. It
keeps its socket bound, its journal open, and its children alive, for as long as the machine runs.

`/health` does not help. It is served by the same loop, so a wedge makes it _unanswerable_ rather than red, and
nothing polls it or acts on a non-answer. Nor does the socket: POSIX `listen` accepts into the backlog without
the process reading anything, so a CLI can connect successfully and then wait forever on a reply that will
never be written. The failure presents as a hang, which is the hardest shape to attribute.

This is why the idle timeout is not the safety net it looks like. It is a _tidiness_ mechanism for a healthy
daemon with nothing to do, and it was read as a liveness backstop during the Darwin containment discussion —
which is the misreading worth recording.

## Why this is neither of its neighbours

[`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) is the same sentence about a
different process, and it has an answer available: the KB daemon has a parent that supervises it, and the gap
is what happens when that parent dies. Here the wedged process **is** the top of the tree. No in-tree party
remains, so no in-tree fix exists.

[`provider-operation-shutdown-quiescence.md`](./provider-operation-shutdown-quiescence.md) assumes shutdown
runs. This entry is about it not running at all.

## The shape of the fix

**The real answer is external**: a launchd job (macOS) or a systemd user unit (Linux) with a watchdog that
restarts a daemon that stops checking in. That is not a code change — it is a decision about whether Coral may
install a service on a machine. Coral installs as a Claude Code plugin from a git subdir and has no installer
that could register one, so this is a product question before it is an engineering one.

**The smaller intermediate, which is a code change**: a liveness file the coordinator touches from an interval
it already owns, and which the CLI stats before connecting. A stale mtime lets `coral-cli` say "the daemon is
wedged, kill it" instead of hanging on a socket that was accepted and never served. It does not recover
anything — it converts an unattributable hang into a diagnosis, which is most of the cost.

Note the intermediate has the same weakness in miniature: a wedged loop stops touching the file, which is
exactly what makes it detectable. The detector must be the reader, never the writer.

## Start condition

**An observation, or a reachable cause.** This has never been seen in the field. Before building either half,
establish that a wedge is reachable at all — the candidates are synchronous work on the loop and an await that
cannot settle. One concrete instance of the first already exists: `probeMacProcessIncarnation`
(`src/infra/node-process.ts`) runs two `execFileSync` calls per probe, so on macOS every process observation
forks `sysctl` and `ps` synchronously. That stalls, it does not wedge — but it is the shape, and it is the
place to look first.

If neither candidate survives that check, the intermediate is the whole answer and the external supervisor
should not be built.
