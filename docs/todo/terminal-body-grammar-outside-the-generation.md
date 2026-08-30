# TODO — the routing journal's address covers part of its body grammar, not all of it

**Status**: open, deferred from `fix/pr1-3-audit`, which is the branch that made the generation derived
in the first place. The documentation that over-claimed this was corrected on that branch; the
mechanism was not.

## What the address covers today

`handoffRoutingStatusGeneration` (`src/store/handoff-routing-status-store.ts`) hashes three things: the
durable-format object the coordinator supplies through `handoffRoutingStatusStoreSchema`
(`src/coordinator/handoff-routing/status.ts`), the fully rendered schema SQL, and the completed-pair
stability predicate. The durable-format object's body vocabulary is two sorted key lists, taken from
the total records `PERSISTED_DISPOSITION_CLASSIFICATIONS` and `HANDOFF_ROUTING_BASIS_OBLIGATIONS`, so
adding a disposition kind or a routing basis moves the address without anyone remembering to wire it.

## What it does not cover

The persisted bodies are decoded by strict Zod schemas, and those schemas hold enumerations that reach
no hashed input. `resolutionReasonSchema` is the clearest one: it is `z.enum(['owner-absent',
'operator-abandoned-unobservable'])`, it is a field of `retirementTombstoneSchema`, and the schema SQL
mentions it nowhere. The DDL pins `event_kind` and `retirement_cause` with `CHECK` constraints, and of
the module's eleven `z.enum` sites those two are the only ones the fingerprint sees at all. The rest —
the `incumbent-unresolved` and `incumbent-unusable` causes, the build `comparison`, the continuation
`source`, the execution throw phase, the invalid-target and strict-bundle-identity failures — are
outside it, as is any *field* added to a persisted body rather than a value added to an enum.

So a build that widens one of them writes rows at the same generation and therefore the same path. An
older build opens the database, its schema comparison passes because the DDL did not change, and the
row fails to decode. `readHandoffRoutingStatus` answers `unreadable`.

## Why this is bounded, and why it is still wrong

It is bounded: `v0.10.9` contains no routing-status writer, so nothing in the field has ever written
this artifact, and the failure needs two builds with different body grammars on one machine. The older
build refuses decisively rather than crashing, and `backend status` names `backend routing-status
discard`, so an operator has a way out. Routing history is derived operational evidence, so the
discard costs no authority.

It is still wrong in what it says. `unreadable` means this journal is damaged; the truth is that
another build wrote it. The whole point of addressing by generation is that the incompatible artifact
becomes *unaddressed* rather than *unreadable* — isolated instead of destroyed. Here the operator is
told to destroy a journal that is perfectly intact for its writer.

## Two shapes for closing it, and they are not equivalent

- **Extend the vocabulary to every enum in a persisted body.** The coordinator already hands over two
  sorted key lists; it would hand over the rest the same way. What makes it hold rather than drift is
  the invariant that must come with it: a source scan asserting every `z.enum([...])` reachable from a
  persisted body schema appears in the durable vocabulary, so a new enum cannot be added silently.
  This closes enum growth and leaves field additions open — an honest partial fix, and it must be
  documented as one rather than described as totality.
- **Give the body grammar one owner.** Invert the dependency: a declarative grammar descriptor from
  which both the Zod schemas and the fingerprint derive, so nothing can be in the grammar without being
  in the address. The only total answer, and the reason it is not the obvious choice is that building
  Zod schemas from a descriptor costs the readability the current schemas have — which is the tradeoff
  whoever takes this has to make deliberately.

Do not close it with a hand-maintained format version number. That constant is exactly what this branch
removed from this mechanism, and it drifted from what it named while it existed.

## Start condition

Startable now. It touches `src/coordinator/handoff-routing/status.ts` and
`src/store/handoff-routing-status-store.ts`, both of which the audit branch has finished with.

## Why deferring is not free

Every value added to one of those enums between now and the fix is a build boundary that reports as
damage. The cost is not the discard — it is that an operator who sees `unreadable` twice learns to
distrust the journal rather than the build boundary.
