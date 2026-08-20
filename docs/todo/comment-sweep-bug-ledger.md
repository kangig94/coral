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

## Sector 4 — `src/jobs`

Nothing found. Every comment naming a symbol, a caller, a file, or an exclusivity claim ("only", "the only")
was checked against the graph or a targeted grep and held up — no orphaned-JSDoc shape, no comment describing
an unenforced constraint, no unreachable branch, and no functional directive (`eslint-disable`, `@ts-expect-
error`, etc.) present in the tree at all. One comment in `event-bus.ts` misattributed a `session:released`
listener to `JobStore` when the actual listener is `WaitCoordinator` in `shell/wait.ts`; that was a plain
delete under the rot test's own "factually wrong is a certain delete" rule, not a ledger-worthy defect, since
the code itself was correct.

## Sector 5 — `src/sessions`, `src/discuss`, `src/workflow`

- **What is wrong**: A JSDoc block on `releaseSessionJobClaim` states a layering rule — "coordinator/services may
  import from sessions contracts but not from sessions shell implementations" — that the tree already violates.
  `src/coordinator/services/provider-event-application.ts` imports `SessionManager` (the sessions-domain shell
  class) directly from `sessions/shell.js` and constructs it via `SessionManager.forProduction(...)` inside
  `sessionManagerWithinTx`, bypassing the wrapper the comment describes. `src/coordinator/execution-service.ts`
  does the same one directory up. The comment itself is not wrong — it correctly describes why the wrapper
  exists and matches how `releaseSessionJobClaim` is written — but the discipline it asserts for
  `coordinator/services` is not what the two importing files do.
- **Where**: `releaseSessionJobClaim` in `src/sessions/job-release.ts` (states the rule); `sessionManagerWithinTx`
  in `src/coordinator/services/provider-event-application.ts` and the module-level import in
  `src/coordinator/execution-service.ts` (break it).
- **Evidence**: `grep -n "sessions/shell" src/coordinator/execution-service.ts src/coordinator/services/provider-event-application.ts`
  shows both importing `SessionManager` from `../sessions/shell.js` / `../../sessions/shell.js`; read directly,
  `provider-event-application.ts:95` calls `SessionManager.forProduction(...)`. Cross-checked against
  `docs/design-rationale.md` §9's cross-domain-contract policy, which this local rule is a stricter instance of.
- **Why it was not fixed**: Comment-only sweep scope; routing these two call sites through
  `releaseSessionJobClaim` (or an equivalent contract) instead of constructing `SessionManager` directly is a
  structural change, not a comment edit.
- **Severity, as observed**: No test failure hit this — both files compile and pass today, since nothing enforces
  the narrower rule the comment states (unlike the directory-level policy in `docs/design-rationale.md`, which
  has no invariant test scoped to `coordinator/services` specifically). Reachability is a future contributor
  reading `job-release.ts`'s doc comment as the actual boundary and being surprised by the existing bypasses, or
  extending the bypass pattern to a third call site on the assumption it is already established practice.

- **What is wrong**: A comment on the outer `catch` in `finalizeSynthesizedSession` claimed "the wired reactor
  implementation already logs and swallows its own discard failures; this catch is a defensive guard for the
  callback itself" (now deleted as part of this sweep — see the sector's diff). The reactor implementation,
  `SessionLifecycleReactor.discardSessionArtifacts`, does not swallow all of its own failures: its catch block
  re-throws `ProviderArtifactArchiveInvariantError` and `ProviderArtifactProtocolInvariantError` rather than
  logging them, and the same file's retention-work recovery path (the `onFault` handler passed to
  `RecoveryContainment`) classifies those exact two error types as `{ kind: 'fatal' }` — i.e. meant to escalate,
  not to be routine cleanup noise. `finalizeSynthesizedSession`'s `catch (error)` has no type discrimination, so
  an invariant error surfacing from the on-demand discard path is caught there and downgraded to an ordinary
  `backendLog.warn`, silently absorbing what the reactor's own re-throw and the recovery path's `fatal`
  classification both treat as something that should not be swallowed.
- **Where**: `finalizeSynthesizedSession` in `src/discuss/shell/flow/synthesis.ts`; `discardSessionArtifacts` and
  the retention-work `onFault` handler in `src/sessions/lifecycle-reactor.ts`.
- **Evidence**: Read directly. `discardSessionArtifacts`'s catch block rethrows
  `error instanceof ProviderArtifactArchiveInvariantError || error instanceof ProviderArtifactProtocolInvariantError`
  and otherwise logs-and-continues; the retention-work `onFault` handler in the same file returns
  `{ kind: 'fatal', error: fault.error }` for the identical two types. `finalizeSynthesizedSession`'s
  `try { await ctx.discardSessionArtifacts?.(...) } catch (error) { backendLog.warn(...) }` has no such
  discrimination. `ctx.discardSessionArtifacts` is confirmed wired to this exact reactor method in
  `src/coordinator/index.ts` (`discardSessionArtifacts: (sessionId) => lifecycleReactor.discardSessionArtifacts(sessionId)`).
- **Why it was not fixed**: Comment-only sweep scope; the fix requires a design decision about what the discuss
  on-demand discard flow should do when it hits one of these two invariant conditions (propagate, quarantine, or
  something else), not just a comment edit.
- **Severity, as observed**: Unproven reachability — this requires the reactor's discard path to hit a malformed
  provider-artifact protocol record or an archived handle that fails hash verification / changes during
  publication, specifically during the on-demand discard triggered at discuss synthesis finalization. Not hit by
  any test failure; inferred from reading both files, not observed via a failing test.

Two additional observations, not ledgered as defects: (1) `src/workflow/wait.ts`, `src/workflow/recover.ts`, and
`src/discuss/session-types.ts` each had a comment trimmed of a change-history or wrong-terminology clause under
the rot test (see the sector's diff) — none were factually wrong claims about current code, so they were excised
rather than ledgered. (2) This sector's tree also carries an internal, undocumented phase-numbering shorthand —
`P4`, `P6`, `P7`, `AC1`, `AC3` (`grep -rhoE '\bP[0-9]\b|\bAC[0-9]\b' --include='*.ts' src/` finds them in
`src/sessions/startup-recovery.ts`, `src/sessions/retention-work-item-recovery-source.ts`,
`src/workflow/startup-recovery.ts`) — that resolves to nothing in `docs/`, the same shape as the cross-sector
"comments cite documents this repository does not contain" finding below but not covered by that finding's
enumeration regex. Left untouched for the same reason that finding gives: deciding whether to bring in, restate,
or drop the reference is not a keep-or-delete call this sweep is authorized to make.

## Sector 6 — `src/coordinator`

- **What is wrong**: `registerRunningRecovery` settles (terminalizes) a job whose provider-binding capture
  failed for an operator-repairable reason (`profile-unavailable`, `identity-unavailable`,
  `subject-mismatch`) even when its durable carrier process may still be alive, instead of quarantining
  with a live-carrier custody transfer. The comment at this site states the gap plainly and is the
  ruling-7 case for this sector: a comment stating a rule the code currently violates, kept rather than
  deleted.
- **Where**: `registerRunningRecovery` in `src/coordinator/services/recovery/actions.ts`.
- **Evidence**: Read directly. The comment cites `docs/todo/coordinator-process-disposition.md`, which
  exists and already tracks this exact gap in full — including why an earlier quarantine attempt
  (`0e59ac52`) was reverted for stranding process ownership, and the Principle 11 clause it violates
  ("A boundary may release local ownership of a still-live or not-proven-absent obligation only after the
  returned disposition names a successor owner..."). This sweep did not discover a new defect; it
  confirmed the comment is accurate and correctly left in place per ruling 7.
- **Why it was not fixed**: Comment-only sweep scope, and the fix (a two-part custody-transfer mechanism)
  is already fully specified in `docs/todo/coordinator-process-disposition.md`. Recorded here only to
  confirm the sweep found and preserved this ruling-7 case — not duplicated in full, since the linked
  TODO is the authoritative record.
- **Severity, as observed**: Already tracked as an open, current TODO with its own reproduction plan; no
  new severity assessment needed from this sweep.

Two comments were found and corrected as factually wrong under the "certain delete" rule (comment wrong,
code correct — not ledger-worthy per that rule): `src/coordinator/live/kb-daemon-supervisor.ts`'s
`stdin.on('error', ...)` handler claimed to "mirror the sibling live transports (app-server-transport,
durable-transport)," but `durable-transport.ts` has no `stdin` handling at all (`grep -n "stdin"` on that
file returns nothing); and `src/coordinator/live/provider-hosts/index.ts`'s `ensureProxySetFor` cited "the
`liveProxySets` field comment" for its per-entry-key rationale, but `liveProxySets` is a local variable in
`src/coordinator/shutdown.ts` whose own comment discusses something unrelated (call-time snapshot safety,
not key sizing) — no comment anywhere in the tree contains the cited reasoning. Both false clauses were
deleted; the code itself was correct in both cases, so nothing else was ledgered.

## Sector 7 — `src/provider-proxy/`

- **What is wrong**: An orphaned-JSDoc shape, the same pattern as the Sector 1 and Sector 3 findings above. A
  JSDoc block beginning "Rebuilds the `BoundProvider` this operation names from its binding envelope. A fresh
  built-in registry per call is cheap …" describes `rebuildBoundProvider`'s own body (it creates a fresh
  registry via `createBuiltInProviderRegistry()`, connects the host authority, and rehydrates the binding) —
  but it sits directly above `BoundProviderReconstruction`, a discriminated-union type declaration with no such
  behavior. `rebuildBoundProvider` itself is declared 23 lines later, past two unrelated helper functions
  (`prepareRefusal`, `boundedRefusalReason`), with no doc comment of its own immediately preceding it.
- **Where**: `rebuildBoundProvider` and `BoundProviderReconstruction`, both in
  `src/provider-proxy/semantic-operation-runner.ts`.
- **Evidence**: Read directly — the block's content (fresh-registry-per-call cost/mutability rationale) matches
  only `rebuildBoundProvider`'s body, not `BoundProviderReconstruction`'s two-variant union, which does no
  registry construction of any kind. Not inferred — the mismatch is legible from the text of the block against
  both declarations.
- **Why it was not fixed**: Comment-only sweep scope is keep-or-delete per the rot test; relocating a comment
  block to sit above a different symbol is a structural edit beyond that mandate, so it was left in place
  rather than moved.
- **Severity, as observed**: Documentation-only; no behavior is affected. A reader who edits
  `BoundProviderReconstruction` expecting the block directly above it to be its own doc, or who looks for
  `rebuildBoundProvider`'s rationale immediately above that function and finds nothing, is the reachable
  confusion. Not hit by any test failure — reachability is as a human-readability defect, not a runtime one.

- **What is wrong**: A provably unreachable branch. `observePairingLoss`'s closing assignment,
  `pairingLossAt = pairingLossAt === null ? now : clock.earlier(pairingLossAt, now)`, can only ever take its
  first arm; the second arm (`clock.earlier(pairingLossAt, now)`) can never execute. The comment beside it
  said so directly ("In practice this is the only report that can ever land — the moment it is recorded,
  `adoptionDeadline` itself collapses to `now`, so any later call already sees itself latched out by
  `sampleBeforeQueuedWork` above") — a comment justifying an unreachable branch rather than the branch being
  removed, so under this sweep's own rule the comment was deleted and the branch is recorded here instead.
- **Where**: `observePairingLoss` in `src/provider-proxy/orphan-deadline.ts`, together with `adoptionDeadline`
  and `sampleBeforeQueuedWork` in the same file, which the unreachability depends on.
- **Evidence**: Traced, not tested. On the first call, `pairingLossAt` is still `null`, so
  `sampleBeforeQueuedWork` computing `adoptionDeadline()` (which returns `derived` while `pairingLossAt` is
  `null`) must find `now < derived` for the call to return non-null at all — call that instant `t1`, so
  `t1 < derived` at the moment `pairingLossAt` is set to `t1`. On every later call, `adoptionDeadline()`
  returns `clock.earlier(derived, pairingLossAt)`; `derived` (built from round-trip evidence) is
  non-decreasing across calls, so `min(derived, t1) = t1` from then on. Because the clock is monotonic, any
  later `now` is `>= t1`, so `sampleBeforeQueuedWork`'s own `clock.compare(now, adoptionDeadline()) >= 0`
  check is always true on a second call, which latches teardown and makes `sampleBeforeQueuedWork` return
  `null` before `observePairingLoss` ever reaches its ternary a second time.
- **Why it was not fixed**: Comment-only sweep scope; deleting a live branch (even a dead one) is a code
  change. This sweep deletes only the comment that described the branch instead of the branch being removed,
  per this sector's own rule that an unreachable branch is ledgered rather than deleted.
- **Severity, as observed**: No behavioral defect — the branch is dead, not wrong, so nothing currently
  depends on `clock.earlier(pairingLossAt, now)` ever running. Reachability is a future reader trusting the
  ternary's second arm as live logic (for example, while modifying it under the belief that pairing loss can
  be recorded more than once), or a coverage tool flagging it once the justifying comment is gone.

Nine comments were found and corrected as factually wrong under the "certain delete" rule (comment wrong,
code correct — not ledger-worthy per that rule), spread across the sector: `handoff-capsule.ts`'s
`proxyHandoffInstallParamsSchema` doc claimed to be "the last send in this protocol that was validated only on
receipt," contradicted by `coordinator/live/provider-proxy/set-authority.ts`, which parses and validates this
exact schema before sending; the same file's `writeHandoffCapsuleFile` doc cited `kb/ops/promote-marker.ts` as
using the same durable-publish primitive, but that file only defines the marker's types/paths — the actual
`writeAtomicDurableSync` caller is `kb/ops/promote-recovery.ts`; `enforcement.ts`'s
`MAX_PROXY_RECORDED_PROVIDER_ROOTS` doc claimed a signal sweep and a receipt were "the only things that read
it," but `guardian.ts`/`reaper.ts`'s `assertRecordedSetAgreement` and `reaper.confirm-provider-root.v1` read it
too; `semantic-operation-runner.ts` named a type `ProxyPreparedAppServerOperationV1`, which does not exist (the
real type is `ProxyPreparedAppServerOperation`); `role-main.ts` twice cited a file `semantic-operation.ts`,
which does not exist anywhere in the repository (the real file is `semantic-operation-runner.ts` — the same
stale name also still appears in `docs/architecture.md` and in
`tests/unit/provider-proxy/semantic-operation.test.ts`, both out of this sweep's scope); `role-main.ts` also
cited a field `environment.process.isAlive`, which does not exist anywhere in the tree (the real field is
`observeLiveness`); and `reaper.ts` attributed a quoted phrase, "one enforcer state machine, not two," to
`orphan-deadline.ts`, which does not contain that quote (the underlying claim — one shared
`EnforcerDeadlineState` enum — is true and was kept; only the fabricated attribution was cut). All nine false
clauses were deleted or excised; the code itself was correct in every case, so nothing else was ledgered.

Two additional observations, not ledgered as defects: (1) A citation form new to this sweep, `plan §"<section
title>"` (e.g. `plan §"Process topology, endpoint, guardian, and authentication"`), appears identically in
both `semantic-operation-runner.ts` and `provider-root-authority.ts`, naming a planning document this
repository does not contain. It was treated the same as the cross-sector "comments cite documents this
repository does not contain" finding below, even though it is not covered by that finding's enumeration regex
— left untouched for the same reason that finding gives. (2) A vaguer, unlocatable form, `(see the task
report)`, appeared twice in `provider-root-authority.ts` and three times in `semantic-operation-runner.ts`.
Unlike `plan §"…"`, this names no section, id, or title — a repository-wide search (`grep -r "task report"`
across `docs/` and `src/`, plus a filename search) found no such document anywhere, so it was treated as an
unlocatable citation rather than a protected external-spec reference, and deleted under the same rule as any
other unverifiable claim.

## Sector 8 — `src/providers/`

Nothing found that meets this ledger's bar (a comment right, code wrong). Of the 32 files carrying any
comment at all, every claim naming a symbol, a file, a caller, a citation, or an "only" was checked against
the graph, a targeted grep, or a direct read of both sides, and every one held up except one, which was a
certain delete rather than a ledger entry (comment wrong, code correct — not ledger-worthy per the sector 7
precedent): `contract.ts`'s JSDoc on `ProviderTerminal` claimed the type is later translated into "a
journal-recorded `ProviderTerminal` (in `jobs/terminal/result.ts`)" and cited "§10.3" for why the two carry
distinct names. Neither survives a check. `jobs/terminal/result.ts` imports and journal-records `JobTerminal`
(from `records.js`), not `ProviderTerminal` — the only `ProviderTerminal` anywhere in the tree is this same
interface, so the sentence is internally self-defeating (it asserts "distinct types, distinct names" while
naming both sides identically). And `docs/design-rationale.md` §10.3 is "Why CLI fail-fast deadlines on Eras I
and II only," unrelated to type-naming discipline. The neighboring `ProviderJobDiagnostics` doc two
declarations below makes the same kind of claim correctly (cites `JobTerminalDiagnostics`, confirmed present in
`jobs/terminal/result.ts`), which is what exposed the mismatch by contrast. The block was deleted outright
rather than corrected to say `JobTerminal`, since supplying the right name would be introducing a new claim,
not excising a false one.

Every other cross-file claim checked out: `aggregateWorkflowUsage` (jobs/workflow-usage.ts), `TerminalOutcome`
and its `causeRef`/fault-registry shape (jobs/outcome.ts), `jobTerminalSchema` (jobs/terminal/result.ts), the
`ProviderCurationCapability` "exposed only through a bound provider" claim (traced — every consumer outside
`internal/bound-provider.ts` and `internal/definition-boundary.ts` reaches it through `BoundProviderCuration`,
never the raw capability), `ProviderHostManager` "pools shared hosts by executable identity"
(`provider-proxy/provider-root-authority.ts`), the architecture-boundary invariant on constructing `AbortError`
locally (`tests/invariants/architecture-boundary.test.ts` §16 #53), the `permissiveProviderLookupPort`
(`tests/helpers/append-context.ts`) test counterpart to `noProviderLookupPort`, the single production call site of
`createCliDetector` (only `claude/cli-detection.ts:detectClaudeCli`, confirmed by grep — the other hit in
`codex/provider-facets.ts` only _mentions_ `resetCache` in a comment), and the exact test name
`'keeps detector caches isolated by process port'` (`tests/unit/providers/claude/cli-detection.test.ts`) quoted
in `cli-detection.ts`.

Recorded once here rather than per sector, because it is one finding with 48 sites and every sector meets it.

- **What is wrong**: Comments cite an external specification and a workstream numbering that no file in the
  repository defines — `W2.3` (18 sites), `W2.5`, `W2.4`, `W2.8`, `Spec §7.1`, `spec §6.4`, `spec §16`,
  `invariant #44`, and `Spec §6.1 line 813`, which carries a line number into a document nobody can open. A
  reader who wants to follow one has nowhere to go, and no reviewer can tell whether the claim beside it still
  holds, because the thing it defers to is not here.
- **Where**: Across `src/`, densest in `src/jobs/` and `src/coordinator/`. Enumerate with
  `grep -rhoE 'Spec §[0-9.]+|spec §[0-9.]+|W[0-9]+\.[0-9]+|invariant #[0-9]+' --include='*.ts' src/`.
- **Evidence**: Observed. The pattern enumerates to 48 occurrences; no file in the tree defines any of these
  identifiers, so each is unresolvable from inside the repository.
- **Why it was not fixed**: Two sectors judged these independently and both declined, for the same reason: the
  citation rule the sweep enforces governs claims about _repository_ files, and these name an outside document.
  Deleting them would discard whatever they defer to; keeping them leaves a pointer that resolves nowhere. That
  is a decision about whether the referenced material still exists and should be brought in, restated, or
  dropped — not a keep-or-delete call the sweep is authorized to make.
- **Severity, as observed**: No runtime effect. The cost is that 48 comments cannot be verified by any reader
  or reviewer, which is the same cost the rot rule exists to remove — so this is unfinished business of the
  sweep rather than a defect it found in passing.

## Sector 9 — `src/cli`, `src/transport`

- **What is wrong**: `BackendHealth` in `src/transport/http/backend/health.ts` is a hand-maintained second copy
  of the producer-side `HealthSnapshot` in `src/transport/server-ports.ts`. The duplication is deliberate and
  correct — the layering invariant forbids transport importing coordinator internals such as the branded
  `RuntimeComponentId` — but nothing holds the two shapes together. Their JSDoc asserted that "the two are kept
  in sync structurally", and no test, type-level `satisfies`, or invariant enforces that sentence, so a field
  added to the producer type can silently fail to reach the `/health` wire shape that external consumers
  validate against.
- **Where**: `BackendHealth` in `src/transport/http/backend/health.ts` and `HealthSnapshot` in
  `src/transport/server-ports.ts`.
- **Evidence**: Observed, not inferred. `tests/unit/transport/http/backend-health-shape.test.ts` pins
  `BackendHealth` alone through `isBackendHealth` and never imports `HealthSnapshot`; no file in `tests/`
  imports both types; and `grep` for `satisfies HealthSnapshot` / `: HealthSnapshot` across `src/transport/`
  returns only `HealthSnapshotPort.read()`'s return annotation, never an assertion against the transport copy.
  Both greps were validated against a known-positive control (`HealthSnapshot` does appear in
  `tests/unit/cli/backend-status.test.ts`), so the negative is not vacuous.
- **Why it was not fixed**: Comment-only sweep. The fix is a new type-level or test-level assertion tying the
  two shapes, which is a code change; and the honest version of it has a design question inside it, because the
  two types are _deliberately_ not identical (the transport copy carries `id: string` where the producer carries
  the branded id), so "in sync" needs a definition before it can be enforced.
- **Severity, as observed**: Reachability unproven — no drift is known to have occurred, and nothing failed. The
  sentence claiming the sync was removed by this sweep as an unenforceable claim, which removes the misleading
  assurance but not the underlying exposure.

- **What is wrong**: `IpcRpcError` (`src/transport/ipc/client.ts`) computes and stores a `code` field in its
  constructor by reading `error.data.code`, and its own class doc says this exists "for CLI error rendering".
  No caller reads it. `cli/errors.ts`'s `transportErrorEnvelope` branch for `IpcRpcError` passes `error.data` —
  not `error.code` — into `structuredBodyError`, which re-derives the identical `body.code` value from that raw
  data independently. The other two catch sites (`cli/expansion/contract.ts`'s `cliBoundaryInstallError`,
  `cli/commands/backend.ts`'s recovery-quarantine catch) only test `instanceof IpcRpcError` and never read
  `.code` either.
- **Where**: `IpcRpcError` in `src/transport/ipc/client.ts`; the unused read is at `transportErrorEnvelope` in
  `src/cli/errors.ts`.
- **Evidence**: Observed. `grep -rn "instanceof IpcRpcError"` across `src/` (excluding tests) returns exactly the
  three sites above; none accesses `.code` on the matched value. `structuredBodyError` in `cli/errors.ts` derives
  `code` from `body.code` where `body` is the passed-in `value` (here `error.data`), which is the same source
  `IpcRpcError`'s constructor already reads — confirmed by reading both implementations side by side.
- **Why it was not fixed**: Comment-only sweep; removing a public class field or its doc is a code change.
- **Severity, as observed**: No runtime effect — the duplicate derivation produces the same value.
  Reachability of a divergence is unproven (the two derivations could disagree only if one were edited without
  the other), so the risk is future maintenance drift between two copies of the same logic, not an active bug.

- **What is wrong**: `errorCodeToExit` (`src/cli/errors.ts`) branches on
  `NOT_OBSERVED_CORAL_SETUP_ERROR_CODES.has(code)`, but the set's only two members
  (`coordinator_record_unreadable`, `coordinator_unreachable`) are constructed exclusively in
  `assertDaemonViewObserved` in `src/cli/expansion/index.ts`. Every call site that can throw one of them
  (`list`/`info` in `createCliExpansionActivation`) wraps the call in a `try`/`catch` that hands the error to
  `encodeInstallError` in the same file, whose `findStructuredSetupError` branch returns before
  `buildErrorEnvelope` (and therefore `errorCodeToExit`) is ever reached. The expansion command's own exit code
  comes from the independent `expansionExitCode` in `src/cli/commands/expansion.ts`. So this branch of
  `errorCodeToExit` has no reachable production caller today.
- **Where**: `errorCodeToExit` in `src/cli/errors.ts`; the codes originate in `assertDaemonViewObserved` in
  `src/cli/expansion/index.ts`.
- **Evidence**: Observed via `trace_path`/`grep`, not merely inferred. `grep` for both code string literals
  across `src/` finds construction only in `expansion/index.ts` (plus the shared-list declaration in
  `runtime/errors.ts`). `encodeInstallError` (`cli/expansion/contract.ts`) calls `findStructuredSetupError`
  before any path that reaches `buildErrorEnvelope`, and returns directly from that branch for a
  `CoralSetupError` match — `buildErrorEnvelope` is never called for these two codes from the only two call
  sites that construct them. `trace_path` on `buildErrorEnvelope` lists callers in every `cli/commands/*.ts`
  registration plus `emit.ts` and `run.ts`, none of which is on the path from `assertDaemonViewObserved`'s
  throw to a handled catch.
- **Why it was not fixed**: Comment-only sweep; the branch is defensive code, not a defect to remove, and
  deciding whether to delete unreachable defensive branches is a design decision outside this sweep's mandate.
- **Severity, as observed**: No runtime effect — the branch is simply unreached. A future caller that routes
  either code through `buildErrorEnvelope` instead of `encodeInstallError` would depend on it; today none does.

## Sector 10 — `src/kb`, `src/kb-daemon`

Nothing found. Every cross-file and cross-symbol claim in the sector's surviving comments checked out against
the graph and the source: the `initPromise`/corpus-mutation-lock/`ConsumerHandle.stop()` trio in
`daemon-main.ts`'s `KbDaemonTerminalWindow` doc (`disposeExpansionScope` in `src/expansion/host.ts` does call
`handle.stop()` without covering the await with the abort signal, confirming the join finishes on its own
schedule); the `SIGKILL_GRACE_MS` semantics cited in the same file's dispose-timing comment (confirmed against
`src/infra/process-containment.ts`, which spends that constant waiting for absence _after_ sending SIGKILL, not
before); `runtime-host.ts`'s claim that the coordinator reads daemon corpus mutations from a persisted
corpus-state row rather than a direct call (`src/coordinator/composition/index.ts` does import `readCorpusState`
from `kb/state/corpus-state.js`); and the two `engine-blind` wiring-point claims in `bundled-loaders.ts` and
`projection-reconcile.ts` (grep over `src/kb-daemon/` confirms `runtime-host.ts` and the coordinator import
`ORAMA_BASE_CONSUMER_ID`/Kiwi engine types only through those two files, never directly from `src/engines/**`).

One comment was factually wrong and was deleted rather than ledgered, since the defect was in the comment, not
the code it described: `ExpansionLifecycleServiceOptions.bundledLoaders`'s JSDoc in
`src/kb-daemon/expansion/lifecycle.ts` claimed the field "defaults to the production `BUNDLED_LOADERS`
registry," naming the export in `src/expansion/bundled.ts`. The actual default, at the only call site
(`applyBundledFallback`'s `this.options.bundledLoaders ?? LIFECYCLE_BUNDLED_LOADERS`), is
`LIFECYCLE_BUNDLED_LOADERS` from `src/kb-daemon/expansion/bundled-loaders.ts` — a different, daemon-local
registry. No code changed; the wrong doc comment was removed.

### `src/kb/curate`

Scope: everything under `src/kb/curate/` not already covered by the `community/` and `classification/`
sweeps folded into Sector 10. Two comments were factually wrong and were deleted rather than ledgered, since
the defect was in the comment, not the code: `RunCommunitySummaryJob`'s JSDoc in `scheduler.ts` claimed its
implementation "composes" the scheduler's abort signal with "the job's own (`coral-cli abort`) signal" — no
implementation ever did this (see the second finding below) — and `INVARIANT`'s JSDoc in `state/model.ts`
pointed to "`kb/curate/scheduler.ts` for the rationale narrative," but `scheduler.ts` only _uses_
`INVARIANT.MAX_CONSECUTIVE_FAILURES`; it carries no narrative to point to.

- **What is wrong**: `initializeCurateStateIfNeeded` in `src/kb/curate/state/bootstrap.ts` re-implements the
  same retry-queue-sweep rule as `syncRetryQueueAgainstIncidents` in `src/kb/corpus/rescan/index.ts` — both
  compute the current incident set, build a set of currently-detected entry IDs, and delete any
  `readCurateRetryQueue` row whose `canonicalIncident` is defined but whose entry is no longer in that set.
  The two are independent implementations of one rule with nothing tying them together.
- **Where**: the closing block of `initializeCurateStateIfNeeded` in `src/kb/curate/state/bootstrap.ts` (the
  `postRewriteIncidents`/`stillDetected` loop immediately before `persistState`); `syncRetryQueueAgainstIncidents`
  in `src/kb/corpus/rescan/index.ts`.
- **Evidence**: Observed. Both bodies apply the exact same predicate —
  `queued.canonicalIncident !== undefined && !stillDetected.has(queued.entryId)` — each against its own
  locally built `stillDetected` set derived from `projectIncidents(buildCorpusScanView(kb))`. Confirmed by
  reading both bodies side by side. The comment this sweep removed from the bootstrap copy (pure narration
  under this sector's rules) had claimed it "mirrors the rebuild pipeline's post-rebuild cleanup," which the
  comparison bears out.
- **Why it was not fixed**: Comment-only sweep; extracting a shared helper is a code change.
- **Severity, as observed**: No known divergence today — both copies currently apply the identical predicate.
  The risk is future maintenance drift: an edit to one copy (e.g. widening or narrowing which rows get swept)
  has no mechanism forcing the other to follow.

- **What is wrong**: `RunCommunitySummaryJob`'s JSDoc in `src/kb/curate/scheduler.ts` described the runtime
  host as choosing between two strategies — "wrap this as an observable `kb.community_summary` job, or call
  the agent directly" — and asserted that the implementation "composes [the scheduler's `runSignal`] with the
  job's own (`coral-cli abort`) signal so a scheduler stop cancels the in-flight agent turn rather than
  blocking `stop()` on it." The only implementation that has ever existed forwards the bare signal straight
  through with no composition, and the "wrap as an observable job" branch has no implementation anywhere:
  `'kb.community_summary'` is declared as a `KbJobOperation` but the literal is never constructed as a launch
  argument anywhere in `src/`.
- **Where**: `RunCommunitySummaryJob` in `src/kb/curate/scheduler.ts`; the sole implementation,
  `runCommunitySummaryJob`, in `src/kb-daemon/runtime-host.ts`; the operation vocabulary in
  `src/jobs/launch.ts`, `src/jobs/records.ts`, `src/jobs/event-bodies.ts`, and `src/jobs/read-queries.ts`.
  `search_graph` for `runCommunitySummaryJob` returns exactly two nodes: the type in `scheduler.ts` and the
  one implementation in `runtime-host.ts`, which is `(signal) => runCommunitySummaryAgent(kb, curateAssistant,
signal)` — a direct pass-through. `git log -S"runCommunitySummaryJob" -- src/kb-daemon/runtime-host.ts`
  shows that line was introduced once and never changed since. `grep -rn "'kb.community_summary'" src/` finds
  the literal only inside schema/type declarations and two read-side `!==` guards (`jobs/read-queries.ts`,
  `jobs/store.ts`); no call site anywhere constructs it to launch a job.
- **Why it was not fixed**: Comment-only sweep; the JSDoc's inaccurate paragraph was deleted rather than
  fixed, since fixing the underlying gap — building the job-wrapped path, or removing the unused operation
  vocabulary — is a code change and a product decision outside this sweep's mandate.
- **Severity, as observed**: No runtime effect — the one real implementation is correct for the "call
  directly" branch it actually takes. The exposure is a documented extensibility path, and a job-operation
  enum member, that nothing has ever built or reached.

## Sector 11 — src/kb remainder, engines, expansion, recovery, read-model, causality

- **What is wrong**: `manifest-types.ts`'s header comment (deleted from the file as part of this sweep, since
  it no longer verifies) justified splitting the file out to break a `kb/contracts.ts ↔ manifest-authority.ts`
  import cycle, on the claim that `manifest-authority.ts` "references `KbRuntime` in its implementations."
  Neither half of the justification holds against the current tree: `manifest-authority.ts` has zero
  references to `KbRuntime` today, and the cited file `kb/contracts.ts` (plural) does not exist — the current
  file is `kb/contract.ts` (singular). The same claim, in the same words, is the canonical worked example in
  `.claude/rules/design-philosophy.md` rule 7 ("Never split a single concept across two files unless a cycle
  physically forces the split... e.g. `manifest-types.ts` exists only to break a `kb/contracts.ts ↔
manifest-authority.ts` cycle"), so a governing project rule's running example no longer verifies against the
  code it describes.
- **Where**: `manifest-types.ts` header in `src/kb/corpus/manifest-types.ts` (now removed);
  `.claude/rules/design-philosophy.md` rule 7 (cites the identical claim).
- **Evidence**: `grep -n "KbRuntime" src/kb/corpus/manifest-authority.ts` returns no matches against the
  current tree. `git show 618c95d1:src/kb/corpus/manifest-authority.ts` shows the file importing `KbRuntime`
  from `../contract.js` at the comment's introduction (commit `618c95d1`), confirming the claim was true when
  written and has since gone stale as that import was removed; the same commit already used the now-nonexistent
  `kb/contracts.ts` filename. `find src/kb -maxdepth 1 -name 'contract*.ts'` shows only `kb/contract.ts`
  (singular) in the current tree.
- **Why it was not fixed**: Comment-only sweep scope; re-justifying or dissolving the file split is an
  architectural decision, and `.claude/rules/design-philosophy.md` is outside this sweep's touched-file
  allowlist (`src/` comments plus this ledger only).
- **Severity, as observed**: No runtime effect — `manifest-types.ts` still compiles and is imported without
  issue regardless of whether a cycle currently forces its existence. The exposure is documentation integrity:
  a governing project rule cites an example that no longer checks out, which could mislead a future
  contributor deciding whether a similar split is warranted elsewhere.

Five comments were found and corrected as factually wrong under the "certain delete" rule (comment wrong, code
correct — not ledger-worthy per the sector 7 precedent), spread across the batch: `causality/render.ts`'s
layer-boundary header claimed domains "import `CauseRef` from this module," but every domain (`jobs/`,
`sessions/`, `workflow/`, `discuss/`) imports `CauseRef` from `causality/cause-ref.js` — what they import from
`render.js` is `typedDescriber`/`EventDescriber`/`EventDescriberMap`; only the false clause was excised, the
true no-domain-import constraint was kept. `engines/orama/document-builder.ts` pointed to "search-channels.ts
ngram note" to justify avoiding spread on long token runs, but `search-channels.ts`'s only comment is about
lazy n-gram generation, and `pushUniqueTerm` never uses spread — the broken pointer was cut, the verified
stack-overflow-avoidance constraint kept. `kb/validation.ts`'s `LOWERCASE_SLUG_PATTERN` and `assertSlug` docs
both cited "memo topic" as an example use, but `assertSlug`'s only two callers pass label `'domain'`; memo
topic is validated by the separate mixed-case `assertNoteSlug` instead. `kb/ops/reindex.ts`'s JSDoc claimed the
caller's abort signal threads "into derive/stage/post-commit checkpoints," but no `throwIfAborted` call site
anywhere in the tree uses those names — the real checkpoints on this path are `'scan'` and `'readiness'`.
`kb/corpus/frontmatter.ts`'s strict-parser comment credited both `extractKnowledgeLinks` and
`serializeKnowledgeBlocks` with only seeing recognized structure, but `extractKnowledgeLinks` lives in a
different file (`wiki-links.ts`) with independent parsing logic and never consumes this function's output —
that half of the claim was cut, the same-file half about `serializeKnowledgeBlocks` was kept.

## Sector 12 — `tests/invariants/`

- **What is wrong**: The `engineIds` allowlist in the "engine-blind domains carry no engine-id string
  literals (AC7.2)" check does not match the codebase's actual set of engine identities. It is missing
  `'kiwi'`, a real, registered engine — `BUNDLED_ENGINES` in `src/expansion/bundled.ts` declares `id: 'kiwi'`
  alongside `'orama'`, `'gemini'`, and `'onnx'`, and the same test file's sibling AC7.1 check
  (`allowedEngineImporters`) explicitly allowlists `src/kb-daemon/expansion/kiwi-boot.ts` as an engine
  importer — so the codebase already treats `kiwi` as a fourth engine identity everywhere except this one
  literal-ban list. A bare string literal `'kiwi'` leaking into `src/kb/`, `src/coordinator/`,
  `src/cli/expansion/`, `src/infra/`, or `src/runtime/` code would therefore not be caught, unlike a leak of
  `'orama'`, `'gemini'`, or `'onnx'`. The set also contains `'kb-scann'`, a token that does not correspond to
  any engine, file, symbol, or other reference anywhere in the tree (a repo-wide grep for `kb-scann` finds
  only this one line) — its origin is unclear and it does not fire the check for anything real.
- **Where**: the `engineIds` constant inside the `'engine-blind domains carry no engine-id string literals
(AC7.2)'` test, in `tests/invariants/architecture-boundary.test.ts`.
- **Evidence**: `grep -n "id: 'kiwi'" src/expansion/bundled.ts` and `grep -n "kiwi-boot" tests/invariants/architecture-boundary.test.ts`
  both hit; `grep -rn "kb-scann" src/ tests/ docs/` returns only the `engineIds` declaration itself. Traced via
  `git log --all -S "kb-scann"` to `78285643` ("test: remove redundant engine acceptance scan (#279)"), the
  commit that introduced the current four-entry set — `'kb-scann'` was already present and `'kiwi'` already
  absent at that point, so this is not drift from a later rename; it was incomplete from that commit onward.
- **Why it was not fixed**: Comment-only sweep scope; correcting `engineIds` is a code change (editing a
  `Set` literal), not a comment edit.
- **Severity, as observed**: Not hit by any test failure — nothing in the current tree leaks a `'kiwi'`
  string literal into an engine-blind scope, so the gap is latent. Reachability is a future edit that
  references the engine by its literal id (rather than through the existing capability-vocabulary slot/
  authority names the check already allows) inside one of the five engine-blind roots; AC7.2 would pass
  regardless, silently certifying the same engine-blindness violation this check exists to catch.

- **What is wrong**: The commit-time-reducer-vs-`rebuildProjections` parity test's discuss-event fixture
  (`session-store-golden.events.jsonl`) exercises only 10 of the 16 `discussEventKinds` the discuss reducer
  registry actually handles. `participants.expelled`, `speech.timed_out`, `epoch.summary.recorded`,
  `must_answer.carry_forward.set`, `follow_up.queue.set`, and `follow_up.answered` never appear in the
  fixture, so a divergence between the production commit-time reducer and the test-side `rebuildProjections`
  helper for any of those six event kinds would not be caught by this parity invariant, contrary to the
  file's own header claim that the test proves the two paths stay byte-identical for all four base
  consumers. A now-deleted inline comment on this same fixture separately and incorrectly claimed it "covers
  every discuss event kind the production reducer handles."
- **Where**: the discuss branch of `it('commit-time reducer state == rebuildProjections state, row by row,
for jobs/sessions/discuss/workflow')` in `tests/invariants/projection-rebuild-parity.test.ts`; fixture at
  `tests/unit/discuss/fixtures/session-store-golden.events.jsonl`; full kind list in `discussEventKinds`,
  `src/discuss/events.ts`.
- **Evidence**: `discussEventKinds` in `src/discuss/events.ts` lists 16 kinds. Parsing the fixture (`python3
-c "import json; ..."` over each JSONL line's `kind`) yields 18 events across only 10 distinct kinds
  (`session.created`, `bidding.opened`, `agent.run.bound`, `agent.job.started`, `agent.job.finished`,
  `bid.submitted`, `bid.round.closed`, `speech.recorded`, `session.ended`, `session.synthesized`). Diffing
  against the full 16-kind list leaves the six named above uncovered.
- **Why it was not fixed**: Comment-only sweep scope; extending the fixture (or the test) to cover the
  remaining six kinds is a test-content change.
- **Severity, as observed**: Not hit by any test failure. Reachability is a future reducer or
  `rebuildProjections`-helper change to one of the six uncovered discuss event kinds shipping a byte-level
  divergence that this invariant would not catch, despite its stated purpose.

## Sector 12 — tests/integration, e2e, helpers, types

Nothing met this ledger's bar (a comment right, code wrong). Every comment naming a symbol, a file, a
caller, a config, or an "only"/"mirrors"/"defaults to"/"already handles" claim was checked against the graph,
a targeted grep, or a direct read of both sides. Four comments were found and corrected as factually wrong
under the "certain delete" rule (comment wrong, code correct — not ledger-worthy per the sector 7 precedent):

- `enforcer-roles.integration.test.ts`'s `unreachableClient()` doc claimed "`stopAndReap`'s own
  `proxyClient`/`reaperClient` are never touched by it — only `guardianClient` is." The two tests in that
  `describe` block wire `reaperClient: reaperControl` (a real, connected reaper) and only `proxyClient` to
  `unreachableClient()`; production `stopAndReap`
  (`src/coordinator/live/provider-proxy/set-authority.ts`) calls both `guardianClient.call('guardian.stop-and-reap.v1', ...)`
  and `reaperClient.call('reaper.stop-and-reap.v1', ...)` in the same `Promise.all`. Only `proxyClient` is
  ever left untouched. The false half (`/reaperClient` and "only `guardianClient` is") was excised, keeping
  "`stopAndReap`'s own `proxyClient` is never touched by it."
- The same file's "refuses a teardown that names a different reaper than this one" test carried a trailing
  clause on its rationale comment — "its own comment used to claim `assertRecordedSetAgreement` alone already
  covered this; it did not" — describing a prior state of a comment that no longer exists in the tree. Change
  history the sweep's own rule rejects outright; excised, keeping "Reach the reaper directly so its own
  identity check is the one under test."
- `continuity-lifecycle.integration.test.ts` cited "see `onDurableProcessIdentity` in `providers/cli-runner.ts`
  and `jobs/shell/launch.ts`." `onDurableProcessIdentity` appears in `src/providers/cli-runner.ts` and is
  invoked in `src/coordinator/live/durable-transport.ts` (inside `spawnDurableJobTransport`, the function the
  same sentence names) — never in `src/jobs/shell/launch.ts`, confirmed by grep. The wrong half of the
  citation was excised rather than repointed to the correct file, per the sector 8 precedent that supplying
  the right name is introducing a new claim, not excising a false one.
- `append-context.ts`'s doc on `permissiveProviderLookupPort` cited "`providerLookupPortFromCatalog(...)` (see
  `coordinator/composition/world.ts`)." The function is real (`src/providers/catalog.ts`), but
  `coordinator/composition/world.ts` neither imports nor calls it — the actual composition site is
  `src/coordinator/index.ts` (three call sites). The wrong parenthetical was excised, keeping the accurate
  sentence about the function itself.

**Continuation — the remaining 37 files in this sector.** The pass above covered 24 files before stopping
without a report; this pass covers the rest of `tests/integration/`, `tests/e2e/`, `tests/helpers/`, and
`tests/types/`. Nothing met this ledger's bar (comment right, code wrong) in any of the 37 files. Two comments
in `process-topology.integration.test.ts` were found and corrected as factually wrong under the "certain
delete" rule (comment wrong, code correct — not ledger-worthy per the same precedent):

- A `/** Writes one guardian bootstrap capsule directly... */` docblock sat immediately before a second,
  correct docblock for the same function, `writeCapsuleSet`. `writeCapsuleSet` writes all three bootstrap
  capsules (guardian, reaper, proxy) in one call — confirmed by reading the function body at its call sites,
  each of which destructures `guardianCapsulePath` alongside sibling capsule fields. The stale docblock was
  deleted, keeping its accurate sibling.
- The file-scope constant `FIXTURE_BUILD_SET_ID` carried a doc claiming it is "the same [build]
  `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than
  foreign." `FIXTURE_BUILD_SET_ID` is used exactly once in the file, as the `buildSetId` passed to a
  `ProviderProxySetLifecycle` fixture in one test; `providerOperationRecord` is called in an unrelated test
  further down, building a `prepare-pending` store row from a locally constructed `operation`/`locator` that
  never references `FIXTURE_BUILD_SET_ID` — confirmed by reading both call sites. The unsupported claim was
  deleted.

## Sector 12 — tests/unit (part 1)

Scope: `tests/unit/coordinator/`, `tests/unit/provider-proxy/`, `tests/unit/transport/`, `tests/unit/jobs/`,
`tests/unit/store/`, `tests/unit/runtime/` — 189 files. Nothing met this ledger's bar (comment right, code
wrong) in any of the six directories. Nine comments were found and corrected as factually wrong under the
"certain delete" rule (comment wrong, code correct — not ledger-worthy per the sector 7 precedent):

- `tests/unit/coordinator/discovery.test.ts` carried a 6-line block describing incarnation derivation as
  "`/proc/stat` btime plus start ticks, btime cached per process" and citing a specific measured value. The
  live mechanism in `src/infra/node-process.ts` is `boot_id` (a per-boot UUID) plus raw `/proc/<pid>/stat`
  start ticks — btime-based derivation was the retired mechanism this exact rewrite replaced; git history
  (`74106797`, `359bb90a5`) confirms the replacement, and `tests/invariants/process-incarnation-opacity.test.ts`
  now bans the string "btime" from `src/`. Only the still-accurate first sentence was kept.
- `tests/unit/coordinator/shutdown-budget.test.ts` carried `// Default: hangs forever. Tests override per
case.` on the harness's default `onShutdown`. Read directly: when `hooksOnShutdown` is omitted the async
  body does nothing and resolves immediately — it does not hang. Both call sites that omit it never rely on a
  hang. The comment was simply wrong; deleted.
- `tests/unit/coordinator/live/provider-hosts/pool.test.ts` carried a vacuity-warning claiming "the only
  assertion touching [`routeAppServerOperation`] elsewhere in this file checks the negative case." False:
  later tests in the same file (added after this comment was written) assert the positive case too, which
  would also catch the mutation the comment worried about. The vacuity claim was accurate when written and
  was invalidated by later test additions that nobody updated it for.
- `tests/unit/provider-proxy/bootstrap-capsule.test.ts` and `tests/unit/provider-proxy/handoff-capsule.test.ts`
  both cited `readBoundedFileAtIdentity` as living in `infra/bundle-manifest.ts`. It is defined in
  `src/infra/bounded-file-read.ts`, confirmed by grep. The wrong citation was excised from the first file
  (leaving the accurate remainder standalone); the second file's block needed its citation as its own
  antecedent and was deleted in full rather than rewritten with invented wording.
- `tests/unit/provider-proxy/protocol.test.ts` carried a block describing "these four request schemas" with a
  per-schema sender breakdown and a reference to "bug 3's missing `jointContainmentReceipt`" as a mutation
  exercised below. The describe block it sits above has three tests, none of which omits that field (which
  only exists on a different schema entirely) — a leftover from a since-pruned fourth test. Deleted along with
  its two now-orphaned inline narration lines.
- `tests/unit/jobs/shell/launch-quiesce.test.ts` carried a comment claiming "the orchestrator calls
  `writeResultArtifact` directly with `runtime.storage`; we observe via `runtime.storage.writeAtomicSync` as a
  proxy." Traced the call chain: `LaunchOrchestrator` calls `progressStore.ensureResultArtifact`, which this
  harness stubs to a total no-op — the described proxy wiring can never fire, and the spy it names is never
  asserted on anywhere in the file. Deleted.
- `tests/unit/jobs/reconcile/lifecycle-recovery.test.ts` cited "(`src/workflow/recover.ts` uses the same
  `getEvent`)." `src/workflow/recover.ts` never imports or calls `getEvent`; it resolves causes via
  `deps.eventsBySeq.get(...)`, a different mechanism — confirmed by reading the file. Only the wrong
  parenthetical was excised; the surrounding constraint (resolve the causeRef, don't trust the terminal alone)
  was kept.
- `tests/unit/runtime/classify-exec-outcome.test.ts`'s file header claimed `classifyExecOutcome` was written
  four times across "three modules" before consolidation. Tracing actual callers found four real call sites
  (`src/kb/ops/source/import.ts`, `src/kb/curate/git-sync.ts`, `src/providers/cli-detection.ts`,
  `src/providers/codex/provider-facets.ts`), not three — the count was wrong in addition to being change
  history. The historical narrative and all counts were deleted; the standing architectural facts (a shared
  rule now backs multiple call sites, a wrong classification is wrong everywhere at once, hand-built
  `ExecResult` fixtures are only trustworthy while this file's rows match real Node behavior) were kept.

One further claim was investigated and found not to hold, so it was not ledgered. A worker sweeping
`tests/unit/store/` flagged `src/store/backend-store-reset.ts`'s `openOrResetBackendStoreDb` as a "third,
independent inline copy" of the generation-readiness switch, with no test coverage of its `legacy-ignored`
branch in this repository's test tree (the worker grepped `tests/unit/store/open-or-reset.test.ts` for
`inspectGenerationReadiness`/`legacy-ignored` and found nothing). Direct verification shows
`openOrResetBackendStoreDb` calls the shared `inspectGenerationReadiness` function directly (not a duplicated
copy of the readiness computation), and its `legacy-ignored` branch — including the `backendLog.warn` call —
is exercised by three tests in the sibling file `tests/unit/store/generation-readiness.test.ts` (`'boots
beside readable legacy history without importing it'`, `'boots beside a foreign legacy generation...'`,
`'boots beside an unreadable legacy store...'`), each of which calls `openOrResetBackendStoreDb` through the
`openGeneratedStore` helper after spying on `backendLog.warn`. The worker's coverage check simply grepped the
wrong file in the same scope.
