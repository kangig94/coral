# TODO — a project source that could not be derived is returned as one that was

**Status**: open and narrow. The durable half was fixed on 2026-08-18; what remains is that one project root
can answer with two different identities inside one process, and one of those identities gets persisted.
Closing it needs a disposition in a port's return type.

## What exists

`resolveProjectSource` (`src/infra/project-source.ts`) answers with a `string`: `<owner>/<repo>` from the git
origin remote, or `local/<basename>`. Two different things produce the second one — git ran and said there is
no remote, and git could not be run just now (the `GIT_REMOTE_PROBE_TIMEOUT_MS` bound on a stalled mount, or a
spawn that failed for want of a process slot or descriptor). The return type cannot tell them apart, and
neither can any caller.

That matters because the string is an identity, not a label. `runtime.paths.projectData` derives the
per-project directory from it (`src/runtime/real.ts`), and `src/kb/paths.ts` puts `memo/` inside that
directory. So a call made while git cannot answer files a memo under `local/<basename>`, and a later read —
after the mount recovers and the real source resolves — looks under `<owner>/<repo>` and does not find it.
Nothing reports this; both directories are legitimate names.

## What is already decided, and what it did not close

The **lifetime-durable** half is closed. `resolveProjectSource` caches only a probe that answered: git ran and
exited, or it could not be launched for a reason that will not change under a running daemon
(`STANDING_PROBE_ERRNOS` in `src/infra/process-constants.ts` — no git binary, no permission to execute it, no
such directory). A probe that could not be answered is remembered separately and only until
`INDECISIVE_PROBE_REPROBE_INTERVAL_MS`, so a recovered mount self-heals without a restart, and a wedged one
costs one probe per interval per root instead of one per call. The predicate is `probeWasDecisive`.

The enumeration sits on the standing side, and it was written the other way round first. Listing the
_transient_ errnos and caching everything else puts the dangerous outcome on the default: every errno nobody
listed becomes a project identity durably misrouted, and the list needed a correction each time one was
noticed — `EAGAIN` and `EMFILE` in one pass, then `ENOMEM`, `ESTALE` and `EIO` in review. Before that, an even
earlier predicate asked "did git answer at all", keyed on the error carrying a numeric `status`; a missing git
binary carries `code: 'ENOENT'` and `status: null`, so on a machine without git nothing was ever cached and
every provider operation and KB tool call re-spawned git for the daemon's lifetime.

That was the important half — before it, one wedge rerouted a project's data directory for the daemon's
lifetime with no invalidation path.

## The residue, stated correctly

It is not "one call's answer may be a guess". Making the fallback expire is what created the residue's actual
shape: **one project root can now resolve to `local/x` early in a process and `<owner>/x` later in the same
process**, and callers are not written for an identity that changes underneath them.

Two consequences, in increasing order of how hard they are to notice:

- `discuss/shell/runtime-services.ts` keys live per-source state by this string — `getDiscussStoreForSource`
  at :138, the membership test at :81, the enumeration at :112. A root that resolves differently after the
  interval gets a second, unrelated set of state, and a lookup made with one identity misses rows filed under
  the other.
- `discuss/shell/recovery.ts` writes it into a persisted continuation as `sourceId` (:252) and then
  **re-derives it on read and rejects the row when the two disagree** (:235,
  `continuation.sourceId !== sourceId`). That is the sharpest form of this: a continuation written while git
  could not answer is not merely filed oddly — the mismatch **throws**, inside `hydrate`, which
  `recovery/containment.ts` turns into a recovery fault routed to `policy.onFault`. So it becomes a quarantine
  subject an operator has to clear, not the silent "no continuation to resume" an earlier revision of this
  line claimed. Durable, outlives the process, and louder than it was described as being.

  A second call at :820 is _not_ part of that path, though an earlier revision of this entry folded it in. It
  builds a `DiscussionSourceCoordinate` whose `sourceId` becomes a recovery-fact detail string, recomputed on
  every scan and never compared against a stored value — so it can be inconsistent between scans but cannot
  reject anything.

So the fix moved the problem from "wrong for the process lifetime, invisibly" to "wrong for one interval, and
whatever was persisted during it stays wrong". That is a real improvement and is not a closure.

Also decided, and not in question: the bound itself stays, and stays best-effort
(`tests/invariants/sync-subprocess-timeout.test.ts`). Removing it would replace a wrong answer with a hang,
which is worse.

## Explicitly out of scope

- The bound's value, and whether git is the right source of a project identity at all.
- `containment-observation-deadline`, which is also about a synchronous probe that cannot be interrupted but
  asks whether a _deadline_ survives it, not what its answer means. Sharing the observation that a wedged
  subprocess blocks everything does not make them one entry, and neither fix produces the other.
- `isGitRepo` in `src/kb/curate/git-sync.ts`, which had the same collapse. It is not part of this entry
  because what a wrong answer costs there is different: it gates behaviour rather than naming anything, so the
  KB stops committing for an interval. Not "persists nothing", which an earlier revision of this line claimed
  and a reviewer corrected — uncommitted KB content is a durable divergence, it is simply not a durable _wrong
  identity_, which is what this entry is about.

  The two were also fixed differently, and the asymmetry is structural rather than pending. `isGitRepo` reads
  an `ExecResult` from the runtime port and delegates to `classifyExecOutcome` (`src/runtime/ports.ts`), the
  one owner of that rule. `resolveProjectSource` cannot: `runtime/real.ts` imports it to build
  `paths.projectSource`, so it sits below the runtime composition and has no port to read a result from. It
  calls `node:child_process` directly and inspects a _thrown_ error, which is a different input, and keeps its
  own `probeWasDecisive`. Unifying them means moving project-source above the runtime, which is a larger change
  than this entry and is not the thing this entry is waiting on.

## Required shape

A third answer, in the type: `resolved | no-remote | undecidable`, with `projectData` refusing to derive a
directory from the third rather than deriving one from a guess, and with the persisting callers above refusing
to write a `sourceId` they were told is undecidable.

The cost is the reason this is a TODO and not a fix. `RuntimePaths.projectSource` returns `string`
(`src/runtime/ports.ts`), and every consumer is written against a value that always exists. The graph puts the
count in double digits and it is not a short list to work through: `providers/inject.ts` for the
`{{PROJECT_SOURCE}}` substitution, `kb/tool-handlers.ts`, `runtime/real.ts` for `projectData` and
`buildSpawnEnv`, `jobs/shell/launch.ts`, `provider-proxy/semantic-operation-runner.ts`,
`coordinator/services/provider-operation-prepare.ts`, and the two discuss sites above. Some of them genuinely
cannot proceed without a value and would need their own disposition for the third answer, which is where the
work actually is.

## What would have to be true to start

Either a report of a memo landing in the wrong directory or a discuss row that stopped matching its source, or
a decision that the port's return type should carry dispositions generally — this would be the first one that
does. Absent both, the recorded residue is the honest state: an identity that can change once per interval per
root, and that is persisted by two discuss callers when it does.
