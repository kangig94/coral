# The unit suite starves the machine it runs on, and some of it waits on real time

**Status**: open, measured. Capped rather than fixed — `vitest/default.ts` limits local workers to 8, which
halves the depth of the stall without removing it. The investigation this entry asks for was deliberately kept
out of the branch that found it.

## What was measured

On a 24-core WSL2 host, `npm test` with an unbounded fork pool:

```
node processes, peak      108
processes in D state      15 at peak, present in 37% of 3s samples
wall time                 77.9 s
```

With `maxWorkers: 8`:

```
node processes, peak       87
processes in D state        6 at peak, present in 40% of samples
wall time                 148.1 s
```

So the cap trades 1.9x wall time for less than half the stall depth, and does not change how often a stall
happens at all. That is why this is a cap and not a fix.

**Why it matters beyond test latency.** A live coordinator sharing that filesystem loses its provider control
lease when the event loop stalls past the heartbeat RPC's 5,000 ms budget, and the reaper then terminates every
job on the proxy set — see [`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md). Twelve
delegated jobs died that way in one day while this suite was running beside them.

## What the cause is, and what it is not

Concurrency, not volume. Measured on the same host:

- one process committing with `synchronous=FULL`: **5.2 ms**, and **8.0 ms** with 300 MB of foreign dirty
  pages already outstanding;
- deleting 2,000 files: **15 ms**, with no measurable effect on commit cost afterwards.

So neither foreign dirty pages nor unlink churn explains a three-second stall. What does is ~108 processes
each creating temp directories, opening SQLite with `synchronous=FULL`, and unlinking, at the same moment. A
C++ build on the same machine writes far more and does not do this, because `ninja -j` bounds its concurrency
and its compilers do not fsync.

An earlier attempt to move test temp files to tmpfs was measured and abandoned: `TMPDIR` on tmpfs left the
suite at 77.96 s against 77.85 s on ext4, because the run is CPU-bound on `transform` and `import` rather than
I/O-bound. A single fsync there is 950x cheaper — 1 ms against 954 ms for 200 commits — and it changed nothing,
which is the evidence that the aggregate is not what hurts.

## What to investigate

**Tests that wait on real time.** 92 of these files spawn child processes, and some coordinate with them by
sleeping. Every such wait is wall-clock time this host does not reliably deliver, and it is also why the same
files are the ones that flake under load. Find them, and replace real sleeps with an injected clock wherever
the thing under test already takes a time port — this codebase has `TimePort` for exactly that.

**Tests that are badly shaped rather than slow.** The `synchronous=FULL` SQLite opens are the expensive part
of the durable-status tests; only seven unit files actually assert durability physics (`fdatasync`,
`syncDirectoryDurable`, `writeAtomicDurableSync`, `integrity_check`). The rest open a real database because it
was the easy way to get a fixture, not because the test is about durability. Those can take the in-memory
storage port instead.

Both are per-file judgements, which is why this is an entry rather than a patch: deciding that a given sleep
is inessential means reading what the test is for.

## Start condition

None — it can start now, and should not be folded into a feature branch. Removing a real sleep or swapping a
fixture changes what a test proves, so each one wants its own reasoning and its own diff.
