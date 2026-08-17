# TODO — a project source that could not be derived is returned as one that was

**Status**: open, narrow, and already half-closed. The durable half was fixed on 2026-08-18; what remains is
one call's worth of wrong answer, and closing it needs a disposition in a port's return type.

## What exists

`resolveProjectSource` (`src/infra/project-source.ts`) answers with a `string`: `<owner>/<repo>` from the git
origin remote, or `local/<basename>`. Two different things produce the second one — git ran and said there is
no remote, and git never answered at all (spawn failure, or the `GIT_REMOTE_PROBE_TIMEOUT_MS` bound on a
stalled mount). The return type cannot tell them apart, and neither can any caller.

That matters because the string is an identity, not a label. `runtime.paths.projectData` derives the
per-project directory from it (`src/runtime/real.ts`), and `src/kb/paths.ts` puts `memo/` inside that
directory. So a call made while git cannot answer files a memo under `local/<basename>`, and a later read —
after the mount recovers and the real source resolves — looks under `<owner>/<repo>` and does not find it.
Nothing reports this; both directories are legitimate names.

## What is already decided, and what it did not close

The **durable** half is closed. `resolveProjectSource` now caches only a decisive answer: if git ran and
exited with a status, the result is remembered; if git never answered, the fallback is returned and _not_
remembered, so the next call probes again and a recovered mount self-heals. The distinction is `gitAnswered`
in that file.

That was the important half — before it, one wedge rerouted a project's data directory for the daemon's
lifetime with no invalidation path. It does not close the residue: **within** the window, the caller still
receives `local/<basename>` and still cannot tell that it is a guess.

Also decided, and not in question: the bound itself stays, and stays best-effort
(`tests/invariants/sync-subprocess-timeout.test.ts`). Removing it would replace a wrong answer with a hang,
which is worse.

## Explicitly out of scope

- The bound's value, and whether git is the right source of a project identity at all.
- `containment-observation-deadline`, which is also about a synchronous probe that cannot be interrupted but
  asks whether a _deadline_ survives it, not what its answer means. Sharing the observation that a wedged
  subprocess blocks everything does not make them one entry, and neither fix produces the other.

## Required shape

A third answer, in the type: `resolved | no-remote | undecidable`, with `projectData` refusing to derive a
directory from the third rather than deriving one from a guess.

The cost is the reason this is a TODO and not a fix. `RuntimePaths.projectSource` returns `string`
(`src/runtime/ports.ts`), and every consumer — provider inject's `{{PROJECT_SOURCE}}` substitution, the KB
tool handlers, discuss's `sourceId`, `projectData` itself — is written against a value that always exists.
Some of them genuinely cannot proceed without one and would need their own disposition for the third answer,
which is where the work actually is.

## What would have to be true to start

Either a report of a memo landing in the wrong directory, or a decision that the port's return type should
carry dispositions generally — this would be the first one that does. Absent both, the recorded residue is
the honest state: one call's answer may be a guess, it is no longer remembered as fact, and the guess is
`local/<basename>`, which is a real directory a reader can find by hand.
