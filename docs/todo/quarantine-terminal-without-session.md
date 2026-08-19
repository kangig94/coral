# TODO — a fixed producer leaves a quarantine backlog nothing clears

**Status**: open, and **smaller than the entry that preceded it**. Rewritten 2026-08-15, hours after the
first version, once the rows were actually read instead of inferred from a status line.

## Correction — the previous version of this document was wrong

It said the rows were **not** #311, that they had "survived a restart onto `0.10.8`", and that the count
"kept rising". All three were wrong, and they were wrong in the same way: the count was read from
`backend status` at intervals and the rows themselves were never opened.

What the rows say:

- Every one is `boundary="retention-release-pair"`, `stage=hydrate` — **exactly the source #311 fixed**.
- The newest was detected at `12:06:18Z`; the restart onto `0.10.8` was `12:12:45Z`. Nothing was created
  after it. The count stood still for the next hour and a half.
- `0.10.6`'s bundle does not contain #311's predicate. `0.10.8`'s does.

So the producer was the old daemon, the fix works, and the "still rising" reading came from sampling a
total that had already stopped moving. The lesson is the same one this directory keeps recording: a
symptom read at intervals is not a measurement, and the cost of opening the record was two commands.

## What was actually happening, confirmed

Every quarantined terminal belongs to a **workflow root job** — 25 such events in the store, all of jobs
that completed successfully. A workflow root has no provider session by construction, so its terminal
legitimately carries no `refs.sessionId`, and a boundary about session claims has nothing to do with it.
`src/sessions/retention-release-pair-recovery-source.ts` says so in as many words. `0.10.6` admitted them
anyway and failed at hydrate on a field the pair never reads.

The first version of this document guessed exactly this shape and then attached it to the wrong
producer. The guess was cheap and right; not checking it was the expensive part.

## What remains open

**A backlog produced by a fixed defect has no owner.** The 24 stale rows kept `recovery` reporting
`degraded` indefinitely on a daemon whose code could no longer produce one. They are individually
disposable — `backend recovery-quarantine clear` re-runs the narrowed scan for that one subject, finds
the predicate now excludes it, and reports `resolved and removed` — but only one row per invocation, and
only if an operator knows to do it.

Two things follow:

1. **A health signal that stays red for a repaired cause teaches the operator to ignore it.** This one
   did: `degraded` was visible for a full day and read as background noise, which is how a genuinely
   different failure sat underneath it unnoticed (below).
2. **Nothing re-evaluates a quarantined subject against the current build.** The disposal exists and is
   correct; what is missing is anything that runs it. A startup pass that retries `active` rows whose
   scan no longer yields them would have emptied this backlog on the first boot of `0.10.8` — which is
   precisely the boot where the operator most wants to know what is still broken.

## Found underneath it

Clearing the 24 left **two** rows of a different boundary, `session-retention-work`, both workflow slot
children of one workflow (`…:0:0` and `…:0:1`). `LifecycleReactor.enforceRetention` throws when
`readyBoundProvider` returns null (`src/sessions/lifecycle-reactor.ts`), and the coordinator log
says why:

```
Retention discard skipped for session 3a15866c-…: The selected Codex profile is
authenticated as a different workspace. Restore the original login or start a new session.
```

**The refusal is correct.** The session's binding records a ChatGPT account subject; `~/.codex` is now
logged into a different one. A retention discard deletes the provider's own session file, and doing that
under an unrelated login would be worse than not doing it.

What is wrong is the **disposition**. A login that has changed is not a transient failure, and storing
it as a retryable row means the condition is retried forever against a state nobody is going to restore.
That is the same disease as the backlog above, arrived at from the other direction: there, the cause was
repaired and the row stayed; here, the cause will never be repaired and the row stays anyway.

### And they could not be cleared at all

The subject key for this boundary is `${sessionId}\u0000${jobId}`
(`src/sessions/retention-work-item-recovery-source.ts`). `recovery-quarantine list` renders every
field with `JSON.stringify`, so it prints as an escape sequence; `clear --key` took its argument from
argv verbatim, and **argv cannot carry a NUL at all**. Copying what `list` printed produced a literal
backslash-u that matched nothing, and the real byte could not be typed. The command's own error message
says "Run `recovery-quarantine list` and copy the exact boundary, key, and revision" — advice that could
not work for the only rows that needed it.

Fixed here: `clear` now unquotes a coordinate that arrives as a JSON string literal, so the printed form
round-trips. Unquoting at the CLI rather than changing the stored key keeps existing durable rows
addressable — the key's shape belongs to the recovery source, not to the command that names it.

The disposition question remains open.

## Explicitly out of scope

#311 itself, the quarantine mechanism, and #316's disposition. This is about what happens to rows a
later build can no longer produce, and about the two rows that are not those.

## Start condition

None for the first half — the disposal already works, and a startup re-evaluation pass is a contained
change against `RecoveryQuarantineStore` and the source registry.

The `session-retention-work` pair now needs only a decision, not a read: should a binding whose account
has changed settle as unrecoverable rather than retry forever, and if so, does the operator get told
which sessions were given up on. The evidence is above.
