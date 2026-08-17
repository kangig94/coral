# TODO — every way Coral ends a process runs on that process's own event loop

**Status**: open, unobserved. Recorded on `refactor/process-incarnation-token` because it was noticed
while reasoning about macOS containment, not because anything failed.

## What exists now

`IdleTimer` (`src/coordinator/live/idle.ts`) polls every 60s and drains after `DEFAULT_IDLE_TIMEOUT_MS`
(`:5`, six hours) of no inflight work. It is the coordinator's only unattended exit.

It runs on the coordinator's own event loop, through `TimePort.setInterval`. So does the shutdown budget, so
does every finalizer it contains, and so does a proxy set's orphan deadline inside its own roles.

## Two failure modes, and an earlier revision of this document merged them

Both end with a daemon that will not retire, which is why they were written as one. They need different
answers, so they are separated here.

**Synchronous starvation — the loop stops turning.** A blocking call or a runaway synchronous stretch, and
nothing else runs: not the idle interval, not a timer, not a request handler. `/health` becomes _unanswerable_
rather than red, and POSIX `listen` accepts into the backlog without the process reading anything, so a CLI
connects successfully and then waits forever for a reply that will never be written. The failure presents as a
hang, which is the hardest shape to attribute.

**Stuck inflight work — the loop turns fine.** A never-settling `await` does **not** stop the event loop, and
saying it did was the error. Timers keep firing, other requests keep being served, and
`/health` keeps answering — operational routes return at `src/transport/http/handler.ts:1342`, before
`deps.admin.beginRequest()` at `:1365`, so they are not even counted. What actually happens is narrower and
quieter: `beginRequest()` ran for the stuck request and `endRequest()` never will, so `inflight` never returns
to zero and `IdleTimer.tryDrain` declines forever. The daemon is healthy by every signal it publishes and will
simply never retire.

## The gap that both share

**Every self-termination path Coral has is scheduled by, or accounted to, the process it is meant to end.**
Nothing outside the daemon has an opinion about whether it should still be running. Under starvation the
schedule never runs; under stuck inflight work it runs and is told there is work.

This is why the idle timeout is not the safety net it looks like. It is a _tidiness_ mechanism for a healthy
daemon with nothing to do — and it was read as a liveness backstop during the Darwin containment discussion,
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

**The smaller intermediate, and it addresses only the first mode**: a liveness file the coordinator touches
from an interval it already owns, and which the CLI stats before connecting. A stale mtime lets `coral-cli`
say "the daemon is starved, kill it" instead of hanging on a socket that was accepted and never served. It
does not recover anything — it converts an unattributable hang into a diagnosis, which is most of the cost.
It works precisely because a starved loop stops touching the file; the detector must be the reader, never the
writer.

**The second mode needs something else entirely**, because the file would keep being touched. What it needs is
inflight _age_: the oldest outstanding request's start time, published on health and bounded by a deadline, so
"one request has been inflight for six hours" is a reportable fact rather than an invisible reason retirement
never happens. That is a smaller and more tractable change than the supervisor, and it should probably go
first.

## Start condition

**An observation, or a reachable cause.** This has never been seen in the field. Before building either half,
establish that a wedge is reachable at all — the candidates are synchronous work on the loop and an await that
cannot settle. One concrete instance of the first already exists: `probeMacProcessIncarnation`
(`src/infra/node-process.ts`) runs two `execFileSync` calls per probe, so on macOS every process observation
forks `sysctl` and `ps` synchronously. That stalls, it does not wedge — but it is the shape, and it is the
place to look first.

If neither candidate survives that check, the intermediate is the whole answer and the external supervisor
should not be built.
