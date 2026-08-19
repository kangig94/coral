# TODO — bugs found while sweeping comments, recorded rather than fixed

**Status**: open, and accumulating. This is a ledger, not a concept entry. The comment-rot sweep reads every
comment in the tree and checks the ones that make a claim, so it walks code nobody is otherwise looking at and
finds defects that have nothing to do with comments. Fixing them inside a comment-only sweep would put
behaviour changes in a diff whose whole reviewability rests on containing none, so each one is written down
here and left alone.

**Shape, stated because it breaks the corpus rule on purpose.** Every other file in this directory is one
concept with one disposition, and [`README.md`](./README.md) asks for that. This file is deliberately a list of
unrelated findings, because the sweep produces them one at a time across fourteen sectors and a file per
finding would bury the index. An entry someone decides to act on graduates: it becomes its own conforming entry
and is struck from here with a pointer to its successor.

## How to add an entry

Append, newest last, under the sector that found it. Each entry carries:

- **What is wrong** — the defect, in one or two sentences.
- **Where** — the symbol and its file. A symbol name and a path, never a line number, matching the citation
  rule the sweep itself enforces.
- **Evidence** — what established it. A graph query, a grep, a read. If it was inferred rather than observed,
  say so in those words; an inference recorded as an observation is how this corpus has been wrong before.
- **Why it was not fixed** — normally "comment-only sweep", but say more when the fix is non-obvious or when
  the defect looks reachable.
- **Severity, as observed** — whether anything is known to have hit it, or whether reachability is unproven.

Do not fix anything while adding an entry. Do not soften a finding to make it fit a sector's scope.

## Sector 1 — `src/infra/`

- **What is wrong**: A JSDoc block describing macOS boot-session caching rationale ("This boot's identity on
  macOS — `kern.bootsessionuuid`, not `kern.boottime`" … "It is not cached for two smaller reasons …") sits
  immediately above an unrelated JSDoc block ("Whether an incarnation from this platform is strong enough to
  authorize a signal …"), which in turn precedes `incarnationMayAuthorizeSignal`. The first block's actual
  subject — the caching decision for the mac boot session id — belongs directly above `readMacBootSessionId`,
  which is declared later in the file with no doc comment of its own immediately preceding it. The two blocks
  are stacked back-to-back with no code or blank separation reasserting which comment binds to which symbol.
- **Where**: `readMacBootSessionId` and `incarnationMayAuthorizeSignal`, both in `src/infra/node-process.ts`.
- **Evidence**: Read directly — the orphaned block's content (boot-session-id caching, `sysctl`, "the hot
  caller was the health response") has no connection to `incarnationMayAuthorizeSignal`'s subject (whether an
  incarnation is strong enough to authorize a signal), and matches `readMacBootSessionId`'s body (which calls
  `sysctl -n kern.bootsessionuuid`) exactly. Not inferred — the mismatch is legible from the text of both
  blocks against both function bodies.
- **Why it was not fixed**: Comment-only sweep scope is keep-or-delete per the rot test; relocating a comment
  block to sit above a different symbol is a structural edit beyond that mandate, so it was left in place
  rather than moved.
- **Severity, as observed**: Documentation-only; no behavior is affected. A reader who edits
  `incarnationMayAuthorizeSignal` expecting the block directly above it to be its own doc, or who looks for
  `readMacBootSessionId`'s rationale immediately above that function and finds nothing, is the reachable
  confusion. Not hit by any test failure — reachability is as a human-readability defect, not a runtime one.

## Sector 3 — `src/runtime`, `src/store`

- **What is wrong**: The same orphaned-JSDoc shape as the Sector 1 finding above. A JSDoc block beginning
  "Every row under `prefix`, the bare prefix itself included …" describes the inclusive-first-page pagination
  contract of `forEachRowUnderPrefix` — it talks about "subsequent pages" advancing past a cursor, which is
  that function's own loop. But it sits directly above a _second_, unrelated JSDoc block ("The first key that
  is _not_ under `prefix` …") that correctly documents `keyPrefixUpperBound`, the function immediately below
  both blocks. `forEachRowUnderPrefix` itself is declared later in the file with no doc comment of its own
  immediately preceding it.
- **Where**: `forEachRowUnderPrefix` and `keyPrefixUpperBound`, both in `src/store/provider-operation-journal.ts`.
- **Evidence**: Read directly — the first block's content (bare-prefix inclusion, "subsequent pages advance
  strictly past the cursor") matches only `forEachRowUnderPrefix`'s pagination loop (the `inclusive`/cursor
  logic), not `keyPrefixUpperBound` (which takes no cursor and runs once). The second block's content (BINARY
  collation, incrementing the last character) matches only `keyPrefixUpperBound`'s body. Not inferred — the
  mismatch is legible from the text of both blocks against both function bodies.
- **Why it was not fixed**: Comment-only sweep scope is keep-or-delete per the rot test; relocating a comment
  block to sit above a different symbol is a structural edit beyond that mandate, so it was left in place
  rather than moved. (Both blocks were separately trimmed of change-history narration under the rot test —
  see the sector's diff — but neither was moved.)
- **Severity, as observed**: Documentation-only; no behavior is affected. A reader who edits
  `keyPrefixUpperBound` expecting the block directly above it to be its own doc, or who looks for
  `forEachRowUnderPrefix`'s pagination rationale immediately above that function and finds nothing, is the
  reachable confusion. Not hit by any test failure — reachability is as a human-readability defect, not a
  runtime one.

- **What is wrong**: Two unrelated functions in different directories share the exact name `sameFileIdentity`
  but compare different fields, so the name alone no longer says what a match means. `src/infra/bounded-file-
read.ts` exports `sameFileIdentity(left, right)` comparing `dev`, `ino`, `mode`, `uid`, `size`, and
  `mtimeNs`. `src/runtime/real.ts` separately declares an unexported, module-private `sameFileIdentity(left,
right)` comparing only `dev` and `ino`. This was found while checking a now-deleted comment in
  `src/store/backend-store-reset.ts` that tried to explain why _its own_ differently-named comparison function
  (`sameEvidenceFileStat`) was "deliberately not" the `infra` one — that comment cited the wrong home file for
  the `infra` export (see the sector's diff) but the underlying "keep names distinct" concern it was raising
  turns out to already be violated one file over, by `real.ts` reusing the same name privately.
- **Where**: `sameFileIdentity` in `src/infra/bounded-file-read.ts` (exported) and `sameFileIdentity` in
  `src/runtime/real.ts` (module-private, used only by that file's `findPathByIdentity`).
- **Evidence**: `grep -n "function sameFileIdentity"` in both files; read both bodies directly to confirm the
  field lists differ (`bounded-file-read.ts` checks six fields including `uid`; `real.ts` checks only `dev`
  and `ino`).
- **Why it was not fixed**: A rename is a code change, out of scope for a comment-only sweep.
- **Severity, as observed**: Naming-ambiguity only; `real.ts`'s copy is module-private so there is no import
  collision and no runtime defect. Reachability is a future reader searching for `sameFileIdentity` and finding
  two same-named-but-different comparisons, or grep-driven refactoring assuming the two are interchangeable.
  Not hit by any test failure.
