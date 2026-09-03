# TODO — the ralph loop hook tells the model to delete the state its skill says to keep

**Status**: open, and the diagnosis is settled — a one-line contradiction, not a design question.
**Observed 2026-09-03** during the `overload-tolerance-floor` implementation: `/coral:ralph` ran in plan mode
across six batches and roughly fifteen hours, and the loop resumed the session **zero** times. Every batch
boundary that landed on a `Stop` needed the operator to type the next instruction by hand.

## The contradiction

`clients/skills/ralph/SKILL.md` step 1 says both modes keep the file:

> **Plan mode**: … → Write `"{flags} implement {plan file path} — all ACs must pass"` to state file prompt.
> **Prompt mode**: everything else. → Write `"{flags} {cleaned prompt}"` to state file.
> Both modes: state file persists for loop continuation.

`buildAdditionalContext` in `clients/hooks/ralph-loop.mjs` injects the opposite, and attributes it to the
skill:

> Ralph loop state file created: `<path>`. Read this file first, then edit it. **In SKILL.md step 1: if plan
> mode, delete this file.** If prompt mode, write your cleaned prompt (flags stripped) to the 'prompt' field…

The injected text is what the model reads first and acts on. In the observed run the model deleted the file
in its first turn and said it was doing so "per protocol" — the protocol says the reverse.

## Why deleting it is silently total

The `Stop` handler's second guard:

```js
const statePath = getStatePath(projectDir, sessionId);
if (!existsSync(statePath)) process.exit(0);
```

A missing file is also the ordinary shape of "this session is not running ralph", so there is nothing to log
and nothing to report. The loop does not fail; it is simply never there. Measured on the observed session:
no `ralph-state-<session>.json` under the project tmp dir after the first turn, and no `🔄 Ralph iteration`
system message at any point.

The terminator plan mode would need already exists — SKILL.md's own step 1 ends with
`When done: <promise>{completionPromise}</promise>` for **both** modes, and the `Stop` handler already matches
it (`extractPromiseText`). So the loop was designed to work in plan mode and only the injected instruction
stops it.

## What this entry is not about

The operator's initial reading was that the hook "fires once and then never again". That is a different hook.
`clients/hooks/kb-promote-gate.mjs` also answers `Stop` with `decision: 'block'`, gated on a session-scoped
flag plus unprocessed memos under the project's `memo/` directory; it blocked once mid-run, was satisfied when
a memo was written, and did not block again. There is no fires-once latch in `ralph-loop.mjs`, and looking for
one will waste the search.

Both hooks defer identically while background work is live (`hasLiveWork` in
`clients/hooks/lib/live-work-registry.mjs`). That behaviour is correct and is not in question.

## Fix

Correct the injected string so plan mode writes its prompt instead of deleting the file, matching what step 1
already says. Then decide whether the string should quote the skill at all: it exists to tell the model where
the file is, and every sentence it adds about *what the skill says* is a second copy of the skill that can
drift from it — which is exactly what happened. A pointer to the path plus "follow step 1" cannot contradict
anything.

Two follow-ups worth doing in the same change:

- A test that a plan-mode `Stop` with an unmatched promise answers `decision: 'block'`. Nothing currently
  covers the plan-mode path of this hook, which is why a total loss of function went unnoticed.
- The missing-state guard should distinguish "not a ralph session" from "a ralph session whose state is gone".
  Today both are the same silent exit, and that is what made this invisible for a fifteen-hour run.

## Interacts with

Nothing. The hook and skill are self-contained.
