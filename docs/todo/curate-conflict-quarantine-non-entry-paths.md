# TODO — three conflict-scope paths can never carry a quarantine row

**Status**: open, and scoped down deliberately rather than missed. A PR-gate review found the gap; the half
that could be closed inside the reviewed files was closed, and the half that could not is here because it
needs a type this branch does not own.

## What exists

`KB_GIT_DIFF_PATHS` (`src/kb/curate/git-sync.ts:34`) is the conflict scope — seven entries:

```
notes/  sources/  principles/  communities/  wiki/  .entity-graph.json  .gitattributes
```

`entryForConflictPath` matches `^(notes|sources|communities|wiki)/(.+)\.md$` and returns `null` for anything
else, so **`principles/`, `.entity-graph.json` and `.gitattributes` can never key a quarantine row**. The
constraint is not the regex; it is `KbEntryId` (`src/kb/entry-types.ts:66`):

```ts
export type KbEntryId = `note:${string}` | `source:${string}` | `community:${string}` | `wiki:${string}`;
```

Everything downstream is keyed on it — `ConflictQuarantineKind`, and `KbDiagnoseIncident.entry_id`
(`src/kb/entry-types.ts:246`, populated at `src/kb/diagnose.ts:36,48`). Principles have no `KbEntryId` at
all: they are addressed by slug through `paths.principlePath(slug)` (`src/kb/read.ts:38,233`), never through
`KbIndex.entries`. `.entity-graph.json` and `.gitattributes` are repository files, not entries.

`.entity-graph.json` is why this matters rather than being a tidy-up. It carries the second registered merge
driver (`GITATTRIBUTES_ENTRIES`, `git-sync.ts:19`), and that driver refuses by throwing —
`runEntityGraphMergeDriver` (`src/kb/curate/entity-graph-merge-driver.ts:97`) reads both sides through
`readEntityGraphPathFromHost` (`:86`), which is a bare `JSON.parse`, and `src/cli/commands/kb.ts:538` routes
any throw to `emitError`, which exits non-zero and leaves git holding the path unmerged with no conflict
markers. So the file most likely to reach the markerless-unmerged recovery path is one of
the three that cannot be recorded.

## What was done

`recoverRebaseConflict` returns `RebaseRecoveryOutcome` (see `recoverRebaseConflict` in
`src/kb/curate/git-sync.ts`) instead of a boolean, so a caller cannot report plain `'recovered'` over a path
that got no row:

```ts
| { status: 'recovered' }
| { status: 'recovered-unaccounted' }
| { status: 'recovered-blind' }
| { status: 'failed' }
```

`'recovered-blind'` is a separate concern from this entry — it means the conflict state could not be read at
all — and it is listed here only so the shape above matches the source.

`logRecoveryOutcome` names those paths, says `kb diagnose` will not list them, and points at the recovery ref
with the `git` command to read it. `tests/unit/kb/git-sync-conflict-recovery.test.ts` drives the
`.entity-graph.json` case and asserts that warn — dropping the clause fails the test. That closes the "a
refusal is not a silent skip" half.

## What is still missing

**The durable half.** §11 asks for "a current status an operator can read, keyed by the identity it can be
acted on with". An unrecordable path still has only a log line: `kb diagnose` (`src/kb/tool-handlers.ts:453`,
`src/kb/queries.ts:111`) reads the quarantine table, and there is no row to read. The operator's own exit is
real — the recovery ref, through `git` — but nothing in Coral will remind them it is outstanding.

**The behavioral distinction dies at the boundary.** `gitSync` maps every recovered status to the same
`usedConflictRecovery = true`, and all of them reach `{ kind: 'ambiguous' }`.
That is defensible — both genuinely need a surface rebuild, and `ambiguous` claims no success about the
conflict — but it means the distinction is observable only through the warn, and there is nothing above
`gitSync` that could act on it even if it wanted to.

## Why it was not done here

Extending `ConflictQuarantineKind` needs a `KbEntryId` variant for files that are not entries, which changes
`src/kb/entry-types.ts` and every consumer keyed on it, `src/kb/diagnose.ts` included. Those were outside the
reviewed file set, and a synthetic identifier pushed through them to satisfy one call site is the kind of
change that should be argued on its own rather than landed as a side effect of a conflict-recovery fix.

## Required shape

A second address space for conflict subjects that are not KB entries, rather than a widened `KbEntryId`.
`KbEntryId` means "a thing the corpus owns and `kb diagnose` can render"; `principles/` and two repository
files are not that, and making them that to reuse one table would put the wrong meaning on the type every
other consumer reads. Concretely: a quarantine subject union of `{ kind: 'entry'; entryId: KbEntryId }` and
`{ kind: 'path'; path: string }`, a `conflict_quarantine` row that stores either, and a `kb diagnose` section
that lists path-keyed rows with the recovery ref and the `git update-ref -d` cleanup already in the warn.

Then `'recovered-unaccounted'` has nothing left to describe and goes, because there is no longer a path
recovery cannot account for — which is the signal that this entry is done. The other statuses answer a
different question and stay.
