# TODO — two builds are live at once during an upgrade

**Status**: open, **re-scored down from "highest severity"**. Its severity came entirely from an
incident that has since been traced to a different cause. The window it describes is real and was never
contingent on that incident, but nothing has yet been observed to break because of it.

## Correction — this document named the wrong cause

An earlier revision opened with the 2026-08-15 incident: four provider jobs, launched as one batch,
terminalized together at `07:53:47`, each recording

```
kind: failed
causeRef → job.progress.emitted { kind: 'recovery_parse_failed',
  cause: { message: 'Running recovery adoption failed: [ … Zod invalid_union … ]' } }
```

and it attributed the parse failure to two builds disagreeing about the shape of `turnId`, inferred
from a diff of the `0.10.6` and `0.10.8` bundles (`turnId:Je(n.turnId)` against `turnId:null`).

**That inference was wrong.** The cause was a single-build defect, traced to source and fixed in #318:
`readCodexPersistedContinuity` rebuilt its result with all three keys always present, so a continuity
with no current turn carried `turnId` as a key holding `undefined`. Production hands that object to
`jsonValueSchema.parse`, a union of `null | boolean | number | string | array | object` — and JSON has
no `undefined`. One build, one writer, one reader, no version skew.

The recorded issue tree is what settles it. Its failing branch is

```
path: ["turnId"], received: "undefined", message: "Required"
```

A version skew would have produced a value of the **wrong type**. This is a value that was **absent**.
The parse never saw a foreign shape; it saw a key that should not have existed.

The batch/re-run asymmetry, which read so strongly as an upgrade boundary, has a simpler explanation:
four jobs at the same lifecycle moment shared the same continuity state, and a later single re-run did
not. The plugin update was the restart that made recovery read continuity at all. It was the occasion,
not the cause.

**The lesson is the document's most durable content.** This entry was written during a consolidation
pass whose own index names "built on a cause that had been inferred rather than reproduced" as one of
the defects it was correcting — and then did exactly that, from a bundle-string diff. A build
difference that is _visible_ at the time of a failure is not thereby the failure's cause. Reproduce
inside one build before writing skew into a record.

## What shipped, and what it leaves

Two independent changes closed the incident and its class:

- **#318** removes the producer. The codex reader now builds the way `buildCodexContinuity` and the
  Claude reader already did, so absent optionals stay absent.
- **#316** removes the destruction. A record this build cannot parse is now quarantined —
  `StoreDecodeError` and `ZodError` route to `{ kind: 'quarantine' }` instead of settling a terminal
  fault. This was this document's "half 1" and it landed as written.

So the data loss is gone, and so is the value that triggered it. What is left is the window itself,
which needs its own justification rather than the incident's.

## What remains genuinely open

Updating the plugin swaps the CLI and the skill bundle **immediately**. The coordinator does not swap —
the process already running keeps serving on the build it started with, for an arbitrarily long time
bounded only by its next restart. The evidence for this is independent of the incident: during it, one
log line showed the daemon reporting `0.10.6` while the environment it handed to spawned children
carried `…/coral/0.10.8/bin` on `PATH`.

Two consequences, and they are not the same problem:

**The record direction — a new CLI writes what an old coordinator reads.** No rule anywhere says a
durable record must be readable by an older reader; nothing enforces additive-only shapes. Since #316
the failure mode is no longer destruction, it is a **stall**: a job the coordinator declines to adopt
sits quarantined until a build that can read it runs, and nothing tells the operator that is why their
job stopped moving. Better than losing the work, still not a behaviour anyone asked for.

**The output direction — a session holding old skill text drives a new CLI.** The plugin swaps skills
and CLI together on disk, but a Claude Code session already running holds the _previous_ skill's text
in its context and keeps invoking against the binary that just changed underneath it. Nothing parses
here and nothing fails; the output is simply read with the wrong expectations. This direction has **no
defense at all** and is the binding constraint on the `wait` contract change — a stale skill reading
the new always-zero exit would convert failure into success. See `cli-machine-channel.md`.

A third, weaker claim worth keeping and worth _not_ trusting: two items in this directory were once
recorded as live defects and turned out to have been fixed two releases earlier, and a stale bundle is
the most plausible channel. That is an inference, of exactly the kind the correction above warns
about. Treat it as motivation, not as evidence.

## Options, none costless

- **Refuse the mixed window.** A CLI whose build differs from the live coordinator hands off or refuses
  rather than writing records the coordinator cannot read. `runCliHandoffPreflight`
  (`src/cli/program.ts:45`) already exists and already runs on every invocation; whether it fires when
  the _sibling bundle_ differs is the one cheap fact that has never been checked, and it decides
  between these options.
- **Make durable records forward-readable.** Additive-only shapes with unknown-key tolerance, so an
  older reader can adopt a newer record. This is the same compatibility rule the jobs read contract
  needs — see `jobs-read-contract-schema-first.md` and `result-artifact-availability.md`, and settle
  all three with one policy rather than three.
- **Restart the coordinator on upgrade.** Honest, but it is the cold upgrade the project rules out, and
  it does not help the jobs already running when the restart happens.

Note that none of these address the output direction. A skill already loaded in a live session cannot
be reached by anything the CLI or coordinator does; that half needs the machine-readable surface
`cli-machine-channel.md` describes, so that a stale reader fails to find its field instead of
misreading a value.

## Evidence to preserve

The incident's records remain in the live store — events `51310` and `51317`, with four
`projection_jobs` rows created `2026-08-15T07:53:47` at `phase='error'` pointing into them. They are
now evidence for **#318**, and they are the counter-example this document exists to remember. Read them
before any retention window removes them.

## Explicitly out of scope

The recovery boundary, the handoff protocol, and the store fingerprint are not redesigned here. Nor is
the continuity defect — it is fixed, and this document is not its home.

## Start condition

Establish `runCliHandoffPreflight`'s behaviour when the sibling bundle differs. It is a single
observation, it is the only unknown gating the record direction's option choice, and it costs nothing.

Then decide whether the record direction is worth doing at all at its re-scored severity, or whether it
should simply be folded into the one compatibility policy shared with the two wire-contract entries.
The output direction does not wait on any of that — it is already the constraint blocking `wait`.
