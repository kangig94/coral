# The unit suite starves the machine it runs on, and some of it waits on real time

**Status**: half closed. The store fixtures are done — see "Closed: the store opens". What remains is the
real-time half, whose measured size is much smaller than this entry originally implied, and the cap itself:
`vitest/default.ts` limits local workers to 8, which halves the depth of the stall without removing it.

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

**Why it matters beyond test latency.** A live coordinator sharing that filesystem can miss its provider
heartbeats. An unanswered 5,000 ms RPC is now retained and retried, but a stall extending beyond the
enforcer's adoption deadline still makes that enforcer terminate every job on the proxy set — see
[`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md). Twelve delegated jobs died through
the earlier immediate-fault policy in one day while this suite was running beside them.

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

**Corrected 2026-08-27: that conclusion was conditional on the device's then-current fsync cost.** The
77.96 s/77.85 s comparison above was taken when one fsync cost about 1 ms, so moving the suite's temp root
could not remove a material bottleneck. The later tmpfs routing was measured after the same filesystem had
degraded to roughly 300 ms per fsync; under that condition the temp root changed the dominant cost. Both
measurements stand, but “changed nothing” does not generalize across those device states and is not a reason
to remove the tmpfs root.

## Closed: the store opens

The half of this entry about badly-shaped fixtures is done. Test database opening was spread across three
helper homes: the runtime-aware formatted-store door, a KB-named duplicate of that operation, and the raw
SQLite handle helper. The duplicated formatted door let the unit-tier rule forget one path. The formatted
variants now live together in `tests/helpers/store-db.ts`; the raw helper remains separate because it
deliberately applies neither the Coral schema nor its pragmas. Every door requires an explicit path.

The rule no longer trusts the path expression a caller presents. Each opened handle reports its own location:
unit and simulation reject file-backed databases, while integration and e2e reject files outside the run's
temporary root. `tests/invariants/unit-tier-store-door-bypass.test.ts` prevents concurrent-tier tests from
constructing `DatabaseSync` or calling the production store opener directly, so a test uses a checked door or
does not open a database. Tests whose behavior depends on reopen, multiple connections, durable routing, or
file classification live under `tests/integration`, which is limited to one worker.

What the entry proposed for this half — "those can take the in-memory storage port instead" — assumed a seam
that does not exist. `openStoreDatabase` and `classifyStoreFile` construct `DatabaseSync` directly rather than
going through `storage.openSqliteDatabaseSync`, and the port's return type has none of the surface a store
handle needs. `':memory:'` was already first class; no port detour was required.

## Still open: tests that wait on real time

Measured 2026-08-29, and the entry's own framing overstated it. The concurrent tier holds **22 raw sleeps
totalling 1,420 ms** — under 1% of the capped suite's wall time. Four of them are `setTimeout(resolve, 0)`,
which are event-loop yields rather than waits. Four more are race forms
(`new Promise<'timeout'>(…)`) that assert something does *not* resolve within a window; those are inherently
time-based and converting one means virtualising the subject's timers too, which is a design change rather
than a swap. `vi.waitFor` appears 232 times but polls and returns on the condition, and 36 files already use
`useFakeTimers`.

So this half is not a load problem. Its justification is flake: on a loaded host a 25 ms wait is not 25 ms,
and a test racing a 300 ms timeout against real work inverts. That justification is now weaker than when it
was written, because the load that produced the flakes is smaller — file-backed store opens are rejected in
this tier and the e2e backend leak that accumulated a set per run is fixed.

Start condition: a flake observed under current conditions, naming which of the 22 sites produced it. Starting
from the list rather than from an observation would be converting sleeps that no longer hurt.

## Start condition

The remaining half is above. It should not be folded into a feature branch: removing a real sleep changes what
a test proves, so each one wants its own reasoning and its own diff.

## Measured 2026-08-25: the cost is fsync, and the lever is the journal mode

The entry above blamed concurrency and recorded that a ramdisk changed nothing, concluding the run was
CPU-bound. **That conclusion was wrong.** It was reached without measuring the device, and the device is the
whole story. Everything below is one sitting on `KANG-HOME`, WSL2, with the repo, `~/.coral` and `/tmp` all on
the same ext4 filesystem on `/dev/sdd` — which is why moving a fraction of the working set to tmpfs could not
help.

Sampling `/proc/meminfo` and `/proc/diskstats` every 500 ms across one `npm test`:

    device busy >= 450ms of every 500ms   137 of 187 samples (73%)
    peak requests in flight               368
    peak processes in D state             10
    peak Dirty                            81 MiB   (against a 256 MiB vm.dirty_bytes cap)

Dirty never approached its cap, so writeback throttling is not the mechanism and
`/etc/sysctl.d/99-coral-writeback.conf` — added during the earlier investigation — does not address this. The
mechanism is request-queue saturation: the device is at 100% utilization with hundreds of queued requests, and
anything else touching that filesystem waits behind them. CPU stays low precisely because everyone is blocked.

Decomposing one durable database lifecycle:

    fsync on an already-open file         4.651 ms
    create+write+fsync+close+unlink       4.894 ms
    create+write+close, no fsync          0.016 ms
    mkdtemp + rm -r                       0.066 ms

`4.651 ms` per fsync is the floor this host imposes: every fsync is a barrier through the WSL2 VHDX to the
Windows host. No Linux-side setting moves it. Two device settings were factually wrong — the kernel had
`/sys/block/sdd/queue/rotational=1` and `read_ahead_kb=8192` for what is an SSD — and correcting both to `0`
and `128` changed the benchmark from 31.45/32.61/34.28 ms to 30.78/30.18/30.93 ms. That is noise. Fixing them
was right; expecting it to help was not.

What the pragmas actually cost, same 150 lifecycles in one process:

    file + WAL + synchronous=FULL         33.11 ms each
    file + WAL + synchronous=OFF          12.83 ms each
    file + journal_mode=MEMORY + sync=OFF  0.07 ms each
    :memory:                               0.03 ms each

The dominant cost is **`journal_mode=WAL`, not `synchronous=FULL`**. Relaxing only the durability pragma buys
2.6x; also leaving WAL buys 473x, because creating the WAL and checkpointing it on close fsync regardless of
`synchronous`. Anyone who reaches for `synchronous=NORMAL` as the fix will get a fifth of the available win and
conclude the theory was wrong.

So the work this entry asks for is narrower than "audit the tests": production keeps WAL and `synchronous=FULL`,
and a test that is not asserting durability physics must be able to open its database with an in-memory journal.
That is a runtime/port-level choice, not a per-test pragma, or the next database opened through the real store
path silently pays the 33 ms again.

## The suite has no margin, which is a finding of its own

Adding one `/proc` sampling loop at 2 Hz alongside `npm test` was enough to fail four unrelated tests —
`drift-signal-disjoint`, `search-mode-branching`, `generation-readiness`, `handoff-routing-status-store` — all
of which pass when run alone. A suite that cannot absorb a sampling loop cannot distinguish a regression from a
busy machine, and every gate run on this host is therefore a coin toss on top of a real result.
