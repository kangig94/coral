# A lifecycle refusal rides a JSON-RPC success envelope

**Status**: open, and deliberately not changed by the operator-less drain branch.

## What it is

An authenticated request that needs a running lifecycle, arriving while the lifecycle is `draining` or
`stopped`, is answered with a JSON-RPC **response** whose `result` is `lifecycleRefusalResult`
(`src/transport/lifecycle-refusal.ts`) rather than with an error envelope. The HTTP gateway answers the
same body under 503. A client decoding by envelope kind therefore sees a fulfilled call for a request that
was refused; only a client that tests the body recognises the refusal, which the unary IPC client does
through `isLifecycleRefusalResult` before it resolves.

Principle 11 names this shape directly: a hold may not be returned through a type whose success means
"done".

## Why it stands for now

Two things, and the first is easy to get wrong.

**It is not a regression.** `main` already answered `{ kind: 'response', result: BACKEND_SHUTTING_DOWN_RESPONSE }`
at both sites. The drain branch gave that literal one canonical home instead of two copies, and made the
matcher test `code` alone so a newer server may add fields to the body without an older reader failing to
recognise a refusal it already understands. The branch improved the shape it did not change.

**Changing it is a cross-version wire decision.** Released CLIs decode this body today. Principle 10 permits
reshaping output so a stale reader fails to find its field, and forbids redefining what a value it already
reads means — so moving to an error envelope is allowed, but it is a change every shipped client meets, and
it has to be decided as one rather than as a cleanup.

## What a fix has to answer

- Which envelope an older CLI meets when it asks a draining daemon for something, and what it prints.
- Whether `drainingRecoveryIngress` — the carve-out that lets catalog and shutdown-abandon requests through
  a drain — keeps its current shape under an error envelope.
- What `tests/invariants/transport/lifecycle-refusal-single-home.test.ts` should pin instead. It currently
  asserts the single home by requiring both sites to write the same `result`, which pins the envelope as a
  side effect of pinning the home; those two claims want separating before either moves.
