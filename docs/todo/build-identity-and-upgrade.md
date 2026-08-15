# TODO — a plugin upgrade destroys in-flight work

**Status**: open, **highest severity of the open set**. Observed 2026-08-15 on a live 0.10.6 daemon
immediately after the plugin was updated to 0.10.8. Four running jobs died together; the operator had
changed nothing but the plugin version.

## What happened

Four provider jobs launched as one batch terminalized simultaneously at `07:53:47`, each after roughly
299 seconds. Every one recorded the same outcome:

```
kind: failed
causeRef → job.progress.emitted { kind: 'recovery_parse_failed',
  cause: { message: 'Running recovery adoption failed: [ … Zod invalid_union … ]' } }
```

The Zod issue that failed was `path: turnId`, `code: invalid_type`, message `Required`.

Re-running the same work one at a time succeeded. That is the tell: a re-run begins and ends inside one
build, while the original batch spanned the version change.

## Why it happens

Updating the plugin swaps the CLI and the skills **immediately**. The coordinator does not swap — the
process already running keeps serving on the build it started with. The daemon in this incident still
reported `0.10.6` while the environment it handed to spawned children carried
`…/coral/0.10.8/bin` on `PATH`, both visible in one log line.

So there is a window — arbitrarily long, bounded only by when the coordinator next restarts — in which
a **new** CLI writes durable records that an **old** coordinator must later read. When the coordinator
recovers those jobs, adoption parses the durable record with its own schema. The two builds disagree
about `turnId`: `0.10.6`'s bundle carries `turnId:Je(n.turnId)` where `0.10.8` carries `turnId:null`.
The parse fails.

**The parse failure then kills the job.** `src/coordinator/services/recovery/index.ts:944` routes
`'Running recovery adoption failed'` into `settleUnexpectedRecoveryFailure` (`:597`), which settles a
`recovery_parse_failed` fault — a terminal outcome. The queued path does the same at `:679` with
`'Queued recovery adoption failed'`. A record this coordinator cannot understand becomes a job this
coordinator destroys.

## Why this is the most severe item open

It violates the project's own standing rule that a cold upgrade can never be forced on a user. The
failure is worse than being asked to restart:

- it is **silent** — the operator updated a plugin, nothing announced a risk;
- it **destroys work** rather than deferring it, and the work is often long-running;
- it is **indiscriminate** — every in-flight job in the window dies, not the one that touched the changed field;
- it **teaches the wrong lesson** — re-running works, so it reads as flakiness rather than as an upgrade hazard.

It also corrupts every other bug report made across an upgrade. Two items in this directory were
recorded as live defects and turned out to have been fixed two releases earlier; the most plausible
channel is a stale skill bundle driving a stale CLI. Measurement and this defect share one root.

## The two halves, and they are separable

**Half 1 — a parse failure must not be a terminal outcome.** Adoption failing to understand a durable
record is not evidence the job failed. It is evidence _this build_ cannot speak for it. The natural
disposition is the one recovery already owns for exactly this shape: quarantine the subject, leave the
job live, and let a build that can parse the record adopt it. `recovery_quarantine` already carries
boundary, subject, revision and error, and already retires a subject that a later pass can resolve.

This half is small, does not depend on the second, and removes the data loss on its own. It is the
first thing to do.

**Half 2 — the window itself.** Options, none costless:

- **Refuse the mixed window.** A CLI whose build differs from the live coordinator hands off or refuses
  rather than writing records the coordinator cannot read. `runCliHandoffPreflight`
  (`src/cli/program.ts:45`) already exists for this and already runs on every invocation; whether it
  fires when the _sibling bundle_ differs is the thing to verify first.
- **Make durable records forward-readable.** Additive-only shapes with unknown-key tolerance, so an
  older reader can adopt a newer record. This is the same compatibility rule the jobs read contract
  needs — see `jobs-read-contract-schema-first.md`, and settle both with one policy rather than two.
- **Restart the coordinator on upgrade.** Honest, but it is the cold upgrade the project rules out, and
  it does not help the jobs already running when the restart happens.

## Evidence to preserve

The incident's records are in the live store: four `projection_jobs` rows created `2026-08-15T07:53:47`
with `phase='error'`, their `terminal` blobs carrying `outcome.causeRef` into
`job.progress.emitted` events `51310` and `51317`. Read them before any retention window removes them.

## Explicitly out of scope

This item does not redesign the recovery boundary, the handoff protocol, or the store fingerprint. It
is about a build destroying work it merely fails to understand, and about the window in which two
builds are live at once.

## Start condition

Begin with half 1 — it is independent, it is where the data loss lives, and it needs no decision about
the window. Verify first whether the same disposition should apply to every
`settleUnexpectedRecoveryFailure` caller or only to the adoption parses; the summary strings at `:944`
and `:679` are the two known ones, and the enumeration should be redone rather than trusted from here.

Half 2 needs the handoff-preflight behaviour established before its options can be compared, and it
should be settled together with the jobs read contract's compatibility rules rather than separately.
