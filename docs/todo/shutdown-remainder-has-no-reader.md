# TODO — the shutdown remainder record is written and nothing reads it

**Status**: open. Track B of kangig94/coral#357, recorded 2026-09-17 when Track A (PR #363) shipped the
writer. The record exists so that what a shutdown left is visible; half of "visible" is missing.

## What exists

`recordShutdownRemainder` (`src/coordinator/shutdown-remainder.ts`) writes
`shutdown-remainder.v1/<instanceId>.json` into the run directory whenever a shutdown finalizes with losses:
one entry per undischarged obligation,
keyed by the ledger's `label`, carrying `{ remainder, settlement: { cause, detail } }`, under a record that
carries `instanceId`, `recordedAt`, `reason`, and `mode`. `readShutdownRemainderStatus` in the
same module decodes it tolerantly — per record and per entry, skips counted — and **has no production
caller**. Its only readers are tests. The older abandonment family beside it does have a surface,
`coral-cli backend shutdown-recovery status` (`src/cli/commands/backend.ts`), which reads
`readShutdownAbandonmentStatus` (`src/coordinator/shutdown-abandonment.ts`) and nothing else.

## What is wrong

[`design-philosophy`](../../.claude/rules/design-philosophy.md) §§11–12 require a refusal to be visible on a
surface its real reader can reach, not merely durable on disk. An artifact nothing renders cannot be acted on;
the shutdown remainder is worth keeping only once a CLI or status surface renders it. After a coordinator
exits `1` the LLM driving the next session — the only reader Coral has, per §12 — runs `backend status` and
sees a fresh coordinator with no history. What the previous one left, and whether the successor adopted it
or the loss was named as `process-exit`, is answerable only by opening a JSON file nobody is told exists.

The second half is narrower. The lifecycle projects a held boundary's `reason` and `exit` into
`LifecycleShutdownRecovery` (`src/coordinator/lifecycle.ts`), and the ledger distinguishes `held` — a
declined boundary with no accepted remainder — from `transfer-pending`, an accepted remainder whose transfer
has not yet committed (`GateResolution`, `src/obligation/settlement.ts`). Whether that distinction survives
the health projection into `backend status`, or collapses into one "shutting down" line, was not checked when
the distinction was made. A reader that cannot tell them apart cannot tell "waiting on the address release"
from "waiting on nothing".

## What closing it requires

- A read surface — most likely an arm of `backend status` for the last record, with the retained history
  on the existing `shutdown-recovery status` verb — rendering each entry's label, owner, evidence kind, and
  settlement cause and detail, plus the skipped counts so a partially unreadable file is reported rather
  than silently shortened. Rendering precedence against the live coordinator's own status is the Track B decision this
  entry inherits from #357.
- The surface **reports and does not solicit**: it names what was left and who owns it, and names no
  command. A `process-exit` entry has no next step; a `successor-recovery` entry's next step is the
  successor's own startup, which has already run by the time anyone reads this.
- Verify, and if necessary carry, `held` versus `transfer-pending` through the health projection as
  distinct renderings.

**Interaction.** [`status-prints-history-it-should-not-carry`](./status-prints-history-it-should-not-carry.md)
argues that `backend status` should not carry history past a threshold and that history belongs on an
inspection verb; the retained 32-instance remainder history is exactly that kind of history, so the last
record and the retained set should land on different verbs, as that entry already concluded for routing.
[`reproducible-fatal-successor-loop`](./reproducible-fatal-successor-loop.md) is observed through this
reader and should not be costed before it exists.
