# A locked store is reported as a corrupt one, with a destructive remediation

**Status, 2026-08-26. Closed.** Store-open failures now have explicit `corrupt-or-unsupported`, `unavailable`,
and `unclassified` dispositions; busy/locked failures refuse with retry-later advice, and unclassified
failures preserve the underlying cause without authorizing discard. The handoff now re-observes the target
after the `SIGKILL` grace and distinguishes gone, alive, and unverified outcomes. Signal cooldown refusals name
the remaining wait instead of manual repair, and the two transient discovery refusals name retry as their
exit. No defect remains open in this entry. It is retained as the incident record and the source of the field
measurements; the live-state unit-test defect remains tracked by
`unit-suite-concurrency-and-real-time-tests.md`.

**One-time field measurement, 2026-08-23, on host `KANG-HOME` and a working `gen2` store.** A coordinator
startup failed with
`store_corrupt_or_unsupported`, `retryable: false`, and this remediation:

> Run `coral-cli backend store-reset discard --target gen2 --flavor prod` to quarantine it before this
> build initializes an empty store.

The cause recorded in the same `startup-diagnostic.json` was `database is locked`. `PRAGMA integrity_check`
on that exact file, run after the incident, returned `ok`. The diagnostic and post-incident check are retained
incident measurements; the original lock state cannot be re-run. The store was never corrupt. An operator who
followed the remediation would have discarded a healthy store because SQLite was momentarily busy.

## What produced it

`classifyStoreForProtocol` in `src/store/active-store-selection-coordination.ts` asks
`classifyBackendStoreFailure` (`src/store/backend-store-reset.ts`) what a thrown error means. Before this
half closed, that classifier answered only "corruption" or `null`, and it was written correctly and
narrowly: it matched only `file is not a database`, `database disk image is malformed`, and `malformed
database schema`. `database is locked` was correctly **not** corruption, so it returned `null`.

The caller then read that `null` as a reason to declare corruption anyway, through
`documentedBackendStoreClassificationFailure`, which emitted `store_corrupt_or_unsupported` for whatever
error it was handed. The discriminator's "this is not corruption" and its "I could not classify this" were
the same value, and the call site resolved both to the destructive one.

This is principle 11 in `.claude/rules/design-philosophy.md`, in the form that principle names explicitly:
`null` carrying two dispositions, and an unknown authorizing a finalization. Declaring corruption is a
finalization — it is what justifies discarding the store.

## Incident fact still not established

- **Which call site fired.** `documentedBackendStoreClassificationFailure` has two callers,
  `classifyStoreForProtocol` and the open/reset path in `src/store/backend-store-reset.ts`. Both produce an
  identical payload (`code`, `path`, `flavor`, `cause`), so the recorded diagnostic cannot distinguish them.
  Both carried the defect and are now fixed; only one is proven to have run in the incident.

**Established after the fact: the harm is confined to advice.** A one-time filesystem and SQL inspection on
`KANG-HOME` found no reset: `store-reset-quarantine/` held nothing newer than 2026-08-14;
`recovery_quarantine` still carried rows detected 2026-08-15; the `events` table was unbroken from sequence 1;
and `PRAGMA integrity_check` returned `ok`. The retained session diagnostics counted two independent sessions
that met this error, and neither acted on the remediation. Those incident-state measurements cannot be
reconstructed once the live store and session history advance. Nothing in the classification path resets a
store on its own — it only tells an operator to. That is the difference between a bad afternoon and lost data,
and it is why the fix is urgent rather than an emergency.

## Closed: store classification

`classifyBackendStoreFailure` now puts all three answers in its return type. Numeric `SQLITE_BUSY`,
`SQLITE_LOCKED`, `SQLITE_CORRUPT`, and `SQLITE_NOTADB` codes decide first; the observed lock text and the three
existing corruption signatures remain fallbacks for errors without a numeric SQLite code. Both callers must
switch over `corrupt-or-unsupported`, `unavailable`, and `unclassified`. Availability maps to
`store_open_contended` with exit `75`; an error this build cannot classify maps to
`store_open_unclassified` with exit `70`. Neither non-corruption refusal names discard as its
successor.

## Closed: two more defects from the same incident

Recorded here because they came from one startup sequence and share its evidence, not because they share a
cause with the above. Each stood alone and closed on 2026-08-26.

**`SIGKILL` was treated as decisive, and it is not.** Before closure, `bindWithHandoff` in
`src/coordinator/handoff.ts` signalled the incumbent, waited out `SIGKILL_GRACE_MS`, found the socket still
bound, and threw
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
`D`. In that live capture, `kill(2)` returned success — establishing that the kernel accepted the request —
the pending-signal mask remained set, and repeated
`ss -xlp`/`/proc/<pid>` observations showed the process holding its socket for minutes while blocked on an
fsync. That transient process state is gone and cannot be re-run. What was observed is "the kernel accepted
the signal request, the grace elapsed, and the verified target remained alive"; neither the syscall return nor
the later target observation establishes that the target dequeued the signal. What cannot be concluded is that
anything is wrong with the socket. The verified target's continued life is a positive process observation,
not the "could not establish" answer reserved for a failed identity observation. The wait-for-I/O disposition
is correct when acceptance was observed and the same target was then observed alive after the grace.

This also explains the sibling failure without a second cause: an incumbent stuck in an ext4 journal commit
is a machine under heavy fsync load, which is when a concurrent opener meets `database is locked`.

**A cooldown was announced as manual repair.** Before closure, `assertSignalCooldown` in
`src/coordinator/handoff.ts` refused a repeated handoff signal within `DEFAULT_SIGNAL_COOLDOWN_MS` and phrased
the refusal as
`Manual repair required: refusing repeated handoff …`. The exit is waiting for the cooldown, and in this
incident that is exactly what happened: the retained `KANG-HOME` startup diagnostics timestamped the SIGKILL
at 06:44:11, the successful startup at 06:45:04, and counted three intervening manual-repair messages. This is
a one-time incident measurement, not a repeatable timing fixture; it shows the system healing on a timer.

The closing change preserves `verifySignalTarget`'s fail-closed policy and consumes the signal port's
acceptance result without treating it as delivery evidence. A rejected signal request is re-observed
immediately: an absent target returns to binding, while a live target names permission or process reach and the
owning service or account that can stop it, and an unverified target refuses immediately and names the fresh
identity observation that would settle it. No rejected request enters the signal ledger or starts a grace, so
it cannot cooldown-fence a later contender on a phantom signal. When each accepted signal's grace expires, the
anchored target is observed before policy or revalidation for another signal. After the kernel accepted
`SIGKILL` and its grace elapsed, observed-alive names heavy-fsync uninterruptible I/O and waiting for it to
complete; observed-gone names retrying the mutating command whose binder clears a stale socket; refused
verification names the same fresh identity observation and the host-service inspection if it remains
unavailable. Cooldown diagnostics report the remaining milliseconds. Fresh discovery that is unavailable or
changed names retry; configured signal policy and discovery records lacking the authority fields needed to
signal name either the owning service/account action or the policy/discovery change that permits a retry.

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

The two historical `sent` lines used the old overclaiming vocabulary. Each records only that `kill(2)` returned
without error, meaning the kernel accepted the signal request.

The order is the evidence. The store error appears only *after* the kernel accepted the `SIGKILL` request and
its grace elapsed, and outlives that point by four minutes. The surviving lock is correlated with the verified
target remaining alive after that grace, but the observation does not identify the lock holder. Attributing it
to `pid=62492` would require a contemporaneous lock-owner pid plus an incarnation token matching the signalled
process. Without that identity evidence, the incumbent remaining in `D` is consistent with the ordering, but
so is a later startup contender acquiring the lock immediately after the incumbent exited. The correlation
remains the sentence that joins this entry's two halves; it does not select between those holder histories.

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

The start condition above is now met — PR2 and PR3 have merged.

## A second defect surfaced with it

`tests/unit/hooks/hooks.test.ts` reads the host's live backend state. While the daemon was refusing to start,
the session-start hook prepended this diagnostic to its output and two assertions that pin the output's first
line failed; both passed again once the daemon recovered, with no code change. A unit test whose result depends
on whether the developer's own daemon happens to be healthy cannot distinguish a regression from a busy
machine. It belongs with the entries in `unit-suite-concurrency-and-real-time-tests.md`.
