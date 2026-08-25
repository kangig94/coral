# A locked store is reported as a corrupt one, with a destructive remediation

**One-time field measurement, 2026-08-23, on host `KANG-HOME` and a working `gen2` store.** A coordinator
startup failed with
`store_corrupt_or_unsupported`, `retryable: false`, and this remediation:

> Run `coral-cli backend store-reset discard --target gen2 --flavor prod` to quarantine it before this
> build initializes an empty store.

The cause recorded in the same `startup-diagnostic.json` was `database is locked`. `PRAGMA integrity_check`
on that exact file, run after the incident, returned `ok`. The diagnostic and post-incident check are retained
incident measurements; the original lock state cannot be re-run. The store was never corrupt. An operator who
followed the remediation would have discarded a healthy store because SQLite was momentarily busy.

## What produces it

`classifyStoreForProtocol` in `src/store/active-store-selection-coordination.ts` asks
`corruptBackendStoreClassificationFromFailure` (`src/store/backend-store-reset.ts`) whether a thrown error
is corruption. That function is written correctly and narrowly: it matches only `file is not a database`,
`database disk image is malformed`, and `malformed database schema`, and returns `null` for anything else.
`database is locked` is correctly **not** corruption, so it returns `null`.

The caller then reads that `null` as a reason to declare corruption anyway, through
`documentedBackendStoreClassificationFailure`, which emits `store_corrupt_or_unsupported` for whatever
error it is handed. The discriminator's "this is not corruption" and its "I could not classify this" are
the same value, and the call site resolves both to the destructive one.

This is principle 11 in `.claude/rules/design-philosophy.md`, in the form that principle names explicitly:
`null` carrying two dispositions, and an unknown authorizing a finalization. Declaring corruption is a
finalization — it is what justifies discarding the store.

## Not yet established

- **Which call site fired.** `documentedBackendStoreClassificationFailure` has two callers,
  `classifyStoreForProtocol` and the open/reset path in `src/store/backend-store-reset.ts`. Both produce an
  identical payload (`code`, `path`, `flavor`, `cause`), so the recorded diagnostic cannot distinguish them.
  Both need the fix; only one is proven to have run.

**Established after the fact: the harm is confined to advice.** A one-time filesystem and SQL inspection on
`KANG-HOME` found no reset: `store-reset-quarantine/` held nothing newer than 2026-08-14;
`recovery_quarantine` still carried rows detected 2026-08-15; the `events` table was unbroken from sequence 1;
and `PRAGMA integrity_check` returned `ok`. The retained session diagnostics counted two independent sessions
that met this error, and neither acted on the remediation. Those incident-state measurements cannot be
reconstructed once the live store and session history advance. Nothing in the classification path resets a
store on its own — it only tells an operator to. That is the difference between a bad afternoon and lost data,
and it is why the fix is urgent rather than an emergency.

## The shape of the fix

A third answer, in the return type. The classifier already distinguishes corruption from non-corruption;
what it cannot say is "this error is about availability, not content". `database is locked` / `SQLITE_BUSY`
is retryable and must reach an outcome that says so — `retryable: true`, and a remediation that names
waiting or retrying rather than discarding. What must never happen is an unrecognized error resolving to
the destructive branch by default: an error this build cannot classify is a refusal to start, not a verdict
about the bytes on disk.

## Two more defects from the same incident

Recorded here because they came from one startup sequence and share its evidence, not because they share a
cause with the above. Each stands alone.

**`SIGKILL` is treated as decisive, and it is not.** `bindWithHandoff` in `src/coordinator/handoff.ts`
signals the incumbent, waits out `SIGKILL_GRACE_MS`, finds the socket still bound, and throws
`Incumbent socket remained bound after SIGKILL grace for pid=<pid>`, which reads as an anomaly about the
socket.

**Corrected 2026-08-23 from a one-time live measurement on `KANG-HOME` — the first version of this entry was
wrong.** It said
a dead pid was being named as the holder, and guessed that a child had inherited the listening descriptor.
Neither is so. `ss -xlp` showed exactly one holder of that socket, the accused pid itself, and the pid was
alive:

```
State:   D (disk sleep)
SigPnd:  0000000000000100     ← SIGKILL(9) pending, undelivered
wchan:   jbd2_log_wait_commit ← blocked in the ext4 journal commit
```

A process in uninterruptible sleep does not receive `SIGKILL`; the kernel queues it until the process leaves
`D`. In that live capture, `kill(2)` returned success, the pending-signal mask remained set, and repeated
`ss -xlp`/`/proc/<pid>` observations showed the process holding its socket for minutes while blocked on an
fsync. That transient process state is gone and cannot be re-run. The message is therefore *literally
accurate* and the conclusion drawn from it is not: what was observed is "the target did not die within the
grace", and what cannot be concluded is that anything is wrong with the socket. The honest disposition is the
third answer — the target could not be observed to have died, because right now it cannot be killed — which is
the same disposition
`.claude/rules/validation.md` already requires on the way in ("only `alive` may authorize SIGKILL"), missing
on the way out.

This also explains the sibling failure without a second cause: an incumbent stuck in an ext4 journal commit
is a machine under heavy fsync load, which is when a concurrent opener meets `database is locked`.

**A cooldown is announced as manual repair.** `assertSignalCooldown` in `src/coordinator/handoff.ts` refuses
a repeated handoff signal within `DEFAULT_SIGNAL_COOLDOWN_MS` and phrases the refusal as
`Manual repair required: refusing repeated handoff …`. The exit is waiting for the cooldown, and in this
incident that is exactly what happened: the retained `KANG-HOME` startup diagnostics timestamped the SIGKILL
at 06:44:11, the successful startup at 06:45:04, and counted three intervening manual-repair messages. This is
a one-time incident measurement, not a repeatable timing fixture; it shows the system healing on a timer.

The escalation path itself is sound and should not be changed on this evidence: `verifySignalTarget` throws
through `refuseSignal` when liveness is anything but observed, so an unobservable pid is never escalated to.

## Start condition

After PR2 and PR3 of `backend-routing-disposition`. Nothing here blocks that work, and the store
misclassification predates it.

## Reproduced in the field, 2026-08-24

Not a reconstruction this time, and the two halves of this entry were observed as one ordered sequence. An
incumbent did not die — it became unkillable, which is the distinction the 2026-08-23 measurement above
established and which the first draft of this section got wrong.

`~/.coral/gen2/run/coordinator.log`, incumbent `pid=62492`:

    13:32:12  control.heartbeat.v1 exceeded its 5000ms budget   (liveClaims=4)
    13:32:50  Incumbent did not exit within 30000ms; sent SIGTERM to pid=62492
    13:33:03  Incumbent did not exit after SIGTERM grace; sent SIGKILL to pid=62492
    13:33:09  Incumbent socket remained bound after SIGKILL grace for pid=62492
    13:34:07  Fatal startup error: The current-generation store is corrupt or unsupported
    13:38:39  started, with no intervention

The order is the evidence. The store error appears only *after* the kill fails, and outlives it by four
minutes. The surviving lock is correlated with that failed kill, but the observation does not identify the
lock holder. Attributing it to `pid=62492` would require a contemporaneous lock-owner pid plus an incarnation
token matching the signalled process. Without that identity evidence, the incumbent remaining in `D` is
consistent with the ordering, but so is a later startup contender acquiring the lock immediately after the
incumbent exited. The correlation remains the sentence that joins this entry's two halves; it does not select
between those holder histories.

The load that produced it was self-inflicted and will recur the same way. Five startup attempts landed in four
seconds — 13:34:31.663, 13:34:31.791, 13:34:32.254, 13:34:35.839, 13:34:35.973 — because mutating commands
that reach ordinary daemon startup relaunch the backend, and a full gate run plus retried waits issues many.
Offline operator commands such as `routing-status discard`, `store-reset discard`, and `kb-commit quarantine`
run locally under socket guards and do not contribute startup attempts. Startup contenders can still pile onto
a wedged incumbent and contend with each other, so retrying daemon-starting commands amplifies the window
rather than shortening it. A fix that only corrects the classification leaves that amplification in place.

The same startup wrote `startup-diagnostic.json` with:

    "code": "store_corrupt_or_unsupported",
    "userMessage": "The current-generation store is corrupt or uses an unsupported format.",
    "remediation": "Run 'coral-cli backend store-reset discard --target gen2 --flavor prod' to quarantine it",
    "context": { "cause": "database is locked" }

`retryable` was recorded as `false`. Both claims were checked and both were wrong. `PRAGMA integrity_check`
on that database answered `ok`, and its `store.db.format` sentinel was byte-identical to the fingerprint
`--print-store-reset-build-identity` reports for the build that refused it. The store was neither corrupt nor
of an unsupported format, and nothing was done to it: the backend started on its own a few minutes later.

So the destructive remedy was offered, as the only named next step, for a database that was healthy and for a
condition that cleared itself. An operator who followed the instruction would have quarantined a 329 MB store
to fix a lock.

The start condition below is now met — PR2 and PR3 have merged.

## A second defect surfaced with it

`tests/unit/hooks/hooks.test.ts` reads the host's live backend state. While the daemon was refusing to start,
the session-start hook prepended this diagnostic to its output and two assertions that pin the output's first
line failed; both passed again once the daemon recovered, with no code change. A unit test whose result depends
on whether the developer's own daemon happens to be healthy cannot distinguish a regression from a busy
machine. It belongs with the entries in `unit-suite-concurrency-and-real-time-tests.md`.
