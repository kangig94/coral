# `backend status` asks a reader who is not there to contain or abandon a set

**Status**: open. Found by a tier-1 review of the operator-less drain branch; pre-existing on `main`, and
left there because the fix is a surface redesign in a different subsystem than that branch's target.

## What is wrong

`formatProviderProxySetOperatorExit` (`src/cli/format/backend.ts`) renders a provider-proxy set's operator
exit into the primary status surface, and each of its three arms is an instruction to a person:

- `contain` prints a labelled `action=` line carrying a `coral-cli` contain command;
- `abandon` prints the same shape carrying an abandon command;
- `gated` tells the reader to wait, then contain.

Principle 12 of `.claude/rules/design-philosophy.md` says a surface reports and does not solicit, and says
why this arm is worse than printing nothing: the reader of CLI output is an LLM, a printed remediation is
something it will literally run, and containment and abandonment are destructive judgements it has no
basis for making. The end user reaches Coral through skills and hooks and will never see this text at all;
the one operator who could judge it is not on the machine.

## Why it was not fixed with the rest

The drain branch removed the *coordinator's* shutdown-obligation abandonment offer, because that offer was
unreachable by construction and could be deleted without deciding anything.
This one is different: the offer is reachable, the commands behind it work, and something still has to
happen to a set whose containment cannot be proven. Deleting the lines without deciding who contains the
set replaces a bad prompt with silence.

So the open question is not the rendering. It is **what decides**, and when. Principle 11 leaves two exits
once the operator exit is withdrawn — an event that will arrive, or a durable quarantine with a supported
retry — and the answer has to name which one each of the three arms gets, plus the deadline after which
the system decides for itself. Only then does the status line become a report: what it is waiting for, and
when it will stop waiting.

## Where it connects

[`operator-exit-orchestration.md`](./operator-exit-orchestration.md) covers `#completeOperatorExit`
(`src/coordinator/services/provider-proxy-set/index.ts`), the producer of the disposition this renders,
and settles that its reported failures are unreachable. That entry defers a decomposition; this one asks a
prior question about the same object, and the two should be picked up together — deciding the exits will
change what the orchestrator has to produce.
