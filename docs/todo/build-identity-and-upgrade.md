# TODO — two builds are live at once during an upgrade

**Status**: open, **narrowed**. Read this block and skip to "Still open"; everything between is why this
document has been wrong three times, kept because the corrections are the part that does not re-derive.

|                |                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shipped**    | The takeover works. A process start time is no longer compared across a process boundary in `probeCoordinator` or on the handoff signal path, so a newer build can obtain the incumbent's `bootToken`, ask it to stand down, and escalate if it does not.                 |
| **Still open** | The mixed window itself: the **record** direction (a new CLI writes what an old coordinator reads), the **output** direction (a live session holding old skill text drives a new CLI), and **observability** (four different situations collapse into one `use-current`). |
| **Elsewhere**  | The same defect, uncorrected, at four other pairs of processes — see `proxy-set-acquisition.md`.                                                                                                                                                                          |

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

### Correction, again — it is triggered, and it died at one gate

**The section below was wrong, and this is the third time this document has been wrong about this
subject.** The trigger exists and fires on every session start: `clients/hooks/session-start.mjs`
calls `spawnBackend` unconditionally, and `bindWithHandoff` lets a strictly newer contender evict an
older incumbent (`incumbentOutranksContender`, `src/transport/ipc/handoff.ts`).

It fired, and it died. From the coordinator log, 2026-08-15:

```
07:43:14.210 INFO  [0.10.8] Incumbent bundleHash=040765a5 pid=3274924; requested shutdown via IPC
07:43:14.211 ERROR [0.10.8] Handoff escalation failed: Manual shutdown required: refusing handoff
                            for pid=3274924 because verified shutdown capability was unavailable
07:43:14.211 ERROR [0.10.8] Fatal startup error
```

One millisecond, twice, and the contender exited. The chain: `probeCoordinator` rejected the discovery
record because a freshly probed start time disagreed with the recorded one → no `bootToken` →
`requestIncumbentShutdown` only attempts a shutdown when it holds that token, so `shutdownAttempted`
stayed false → the gate at `coordinator/handoff.ts` threw. A token was needed to attempt, and the
attempt was needed to excuse the missing token.

The disagreement is not a clock going wrong. The primitive, `probeProcessStartedAtSeconds`, added
`/proc/stat` btime over a module-level cache, so two processes' values differed by the age gap between
their first reads — measured at 168 seconds for a coordinator probing its own pid. The value was a
process-local pid disambiguator, not a timestamp, and comparing it across a process boundary was
meaningless.

**Fixed**: the primitive is gone (#324 replaced it with an opaque `ProcessIncarnation`), `probeCoordinator`
no longer compares a start time at all (liveness only), and the signal path anchors on a baseline the
contender observed itself, which keeps the guarantee that matters — the pid must not have been recycled
between handshake and signal — and drops the one that was never sound.

`proxy-set-acquisition.md` is the same defect at a different pair of processes. They were filed as two
items and are one.

### Superseded: "designed, built, and never triggered"

Observed 2026-08-15, four hours after `0.10.8` was installed: the live coordinator was still `0.10.6`,
pid unchanged since boot, serving a `0.10.8` CLI. It had accumulated 27 unresolved quarantine rows,
none of the release's fixes in effect, and the operator's report was that the tool had become unstable.
Nothing was wrong with the fixes. They had never run.

The intended behaviour exists: `createReplacementBackendOwnershipChecker`
(`src/coordinator/ownership-checker.ts`) polls the discovery record every 30s and, on seeing a
**different `instanceId`**, calls `idleTimer.requestDrain('replaced')`, which `shutdownModeFromReason`
routes to a handoff-mode drain. An incumbent yielding to a successor is a solved problem.

What is missing is anything that makes a successor start. Three entry points could, and none compares
build identity:

| Entry point                                              | What it decides on                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `clients/hooks/session-start.mjs` (`isCoordinatorAlive`) | pid liveness only — no version, no bundle hash                     |
| `routeLiveIncumbent` (`src/infra/backend-routing.ts`)    | a newer invoking CLI is told to **use the incumbent**              |
| `src/transport/ipc/ensure.ts`                            | discovery-record ↔ health self-consistency, not "is this my build" |

So the incumbent can only learn it has been replaced by seeing a successor's `instanceId`; a successor
only appears if one starts; and nothing starts one. The loop never closes, and the old daemon serves
until something unrelated kills it.

**An earlier revision of this document called that "permitted by design."** It is not — the design is
present and unreached. The corrected reading is that the mixed window is not a policy choice but an
unfinished path, which also changes its severity: this is not a latent compatibility question, it is the
reason a shipped fix can sit installed and inert for as long as a daemon stays up.

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

- ~~**Finish the takeover.**~~ **Done.** It never needed a new entry point: the session-start hook
  already spawns a contender unconditionally, and `bindWithHandoff` already evicts an older incumbent.
  What it needed was for the contender to stop discarding the incumbent's credential over a comparison
  that could not hold.
- ~~**Refuse the mixed window.**~~ Ruled out earlier and still ruled out: refusing is a cold upgrade,
  and handing off backwards makes the upgrade silently not take effect. Note that this is a different
  question from the takeover above — refusing keeps the old daemon, finishing the takeover replaces it.
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

## What the preflight actually does, since it keeps being assumed

`runCliHandoffPreflight` runs on every invocation and does reach a build comparison. The decision is
`routeLiveIncumbent` (`src/infra/backend-routing.ts`): same build set → use the incumbent; then
`compareProductVersions`, and **a newer or equal invoker also uses the incumbent**. Only an older
invoker hands off, to the newer bundle. Confirmed live against a machine in the window: the `0.10.8`
CLI ran against the `0.10.6` daemon, exited 0, and reported `Version: 0.10.6` with no notice.

`useLiveIncumbent()` returns `createUseCurrentBackendRouting()` — literally the same value the preflight
returns when no coordinator is running at all. Three gates fall back to it with no trace:

| Fallback                                                           | Site                                |
| ------------------------------------------------------------------ | ----------------------------------- |
| incumbent omits `manifest`/`bundleDir` (older or non-strict build) | `src/coordinator/handoff-runner.ts` |
| invoking bundle's strict identity does not resolve                 | `src/coordinator/handoff-runner.ts` |
| foreign-target validation rejects the incumbent's bundle           | `src/infra/backend-routing.ts`      |

So a process can be in the mixed window for four different reasons and nothing distinguishes them.
Observed and unresolved: a `0.10.5` CLI against the `0.10.6` daemon should hand off by that code and
printed no handoff notice, and which fallback fired is not determinable from outside. That is the defect.

At the far end, a `0.10.4` CLI reports **`Backend not running`** against a live daemon — it predates the
strict-identity protocol entirely. Its own message then says a mutating command relaunches the backend,
which points at two coordinators over one journal. Not tested, deliberately; see
the socket-identity fix, which has since landed.

## Start condition

1. **Make the window observable.** Carry the reason on the routing result instead of collapsing four
   situations into one `use-current`, and surface it in `backend status`. Small, blocks nothing, and it
   is why the August incident stayed misattributed as long as it did.
2. **Fold the record direction into the one compatibility policy** shared with
   `jobs-read-contract-schema-first.md` and `result-artifact-availability.md`. It is a consumer of a
   policy those two need anyway, not a driver.
3. **The output direction** waits on none of that — it is already the constraint blocking `wait`.
