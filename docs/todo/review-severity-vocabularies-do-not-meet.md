# TODO — the consolidator reads three severity vocabularies and can order only one

**Status**: open, measured 2026-09-29. Needs a decision about the agents, not an edit to the protocol.

## What does not meet

`tier-review`'s Phase 4 consolidates every reviewer into one Consolidated Findings table whose Severity
column admits `BLOCKING`, `STRONG`, `MINOR`, and whose merge rule 3 resolves disagreement by taking "the
higher severity". That presumes one ordered scale. Measured 2026-09-29 the agents it spawns do not share one:

- `.claude/agents/code-critic.md`, `doc-critic.md`, `test-critic.md`, `ux-critic.md` label
  `BLOCKING/STRONG/MINOR` and emit `Verdict: PASS / NEEDS WORK` — the scale the protocol expects.
- `.claude/agents/integration-guardian.md` labels `BLOCKING/STRONG/MINOR` since the change that surfaced
  this, and emits `Verdict: PASS / FAIL` — conforming on scale, and the only agent with a fourth verdict word.
- `.claude/agents/skill-quality.md` labels `HIGH/MEDIUM/LOW`.
- `.claude/agents/hook-safety.md` has no severity column at all.
- `clients/agents/architect.md`, which Phase 1 adds at tier 1 **by default**, labels
  `CRITICAL/HIGH/MEDIUM/LOW` and emits **no verdict at all**.

Merge rule 3 cannot order `HIGH` against `STRONG`. Rule 1 decides that such a finding is labelled and must
be carried verbatim rather than floored or dropped, so the evidence survives — but a verbatim `HIGH` matches
no row of the verdict table, so it can never fire `REJECT` or `NEEDS WORK`.

## Why the obvious fix was not taken here

The change that surfaced this added `NO VERDICT` to the per-agent verdict column, so that an INVOKED agent
that emits none is recorded honestly rather than sharing `-` with SKIPPED — one value carrying two
dispositions is what `.claude/rules/design-philosophy.md` §11 forbids.

It stopped there. One reviewing agent proposed that `NO VERDICT` should also cap the run at `NEEDS WORK`. That cannot ship as stated: architect emits no verdict *by design* and is a default tier 1
agent, so the cap would make `APPROVED` unreachable on every run that includes it. The cap is only correct once "emits no verdict" is distinguishable from "should have emitted one and did
not" — which would mean reading each agent's own format to see whether it defines a verdict at all. Nothing
does that today.

Mapping the foreign scales in the protocol has the mirror problem: it would teach a template that ships to
arbitrary projects about the scales three of *this* repository's agents happen to use.

## What closing it requires

Decide at the agents, not at the consolidator — §11 puts classification where the fact is known.
Either normalize `skill-quality`, `hook-safety` and `architect` onto `BLOCKING/STRONG/MINOR`, or give
architect a verdict and state per agent how its scale maps. Normalizing is the smaller change and removes the question rather than answering it. Its cost is that
architect's four-level ordering disappears from the consolidator's input; whether that ordering is
load-bearing is part of the decision, not something this entry settles.

Normalizing the labels does not by itself give architect a verdict, so `NO VERDICT` would still be its
normal output; only the second option changes that. Until one of them lands, `NO VERDICT` floors an
unlabelled finding at STRONG and carries nothing further.
