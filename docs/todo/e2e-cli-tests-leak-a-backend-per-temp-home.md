# The e2e CLI tests leak a backend set per temporary HOME

Three `describe` blocks in `tests/e2e/cli/main.test.ts` point `HOME` at a fresh `mkdtempSync` directory and
then run a mutating `coral-cli` command. A mutating command relaunches the daemon — the CLI says so in its own
not-running notice — so each such test starts a backend rooted in that temporary HOME. `afterEach` calls
`rmSync(tmpDir, { recursive: true, force: true })` and nothing else. The directory goes; the daemon stays.

## What was measured

`npm run test:e2e:build` on 2026-08-24 at 15:54 left five `clients/build/coral-backend.cjs` processes alive.
Twenty minutes later they were still running. Two of them held a coordinator socket under a
`/tmp/coral-cli-test-*` root, and one of those roots was already gone from `/tmp` while its backend ran — the
`rmSync` had succeeded and the process had not noticed.

Sets accumulate across runs rather than replacing each other. Before that run, four sets were alive from gate
runs at 10:49 and 12:48 the same day, still holding deleted roots hours later. Each set is four roles:
coordinator, guardian, reaper, proxy.

## Why it matters, and why it is not the reaper bug

These are isolated: they bind `/tmp/coral-cli-test-*/.coral/gen2/run/coordinator.sock`, never the real
`~/.coral/gen2/run/coordinator.sock`. A leaked set cannot take over the live daemon or reap a live job, and a
build-conflict reading of them is wrong — that hypothesis was checked against `/proc/net/unix` and refused.

What they do is run heartbeat loops forever on a machine that already loses provider control leases when its
event loop stalls past the 5s heartbeat budget (see `unit-suite-concurrency-and-real-time-tests.md`). Every
full gate adds another four processes to whatever the next gate has to run against. This is a contributor to
the stall depth that entry measures, not the cause of it.

## Start condition

Ready. It needs no decision from another entry.

## What a fix must not do

It must not shut the daemon down by reaching for the real root. The temp-HOME redirection is the isolation
that makes these tests safe, and a teardown that resolves the socket from anything other than the same
`HOME` the test set would terminate the developer's live backend from inside the suite.

It must also not assume the directory still exists at teardown time. The observed order was `rmSync` first,
daemon alive after, so a teardown that shuts down by reading a discovery record out of `tmpDir` has to run
before the removal — or the removal has to move after it.
