# TODO — give the CLI a machine channel so contracts stop riding presentation

**Status**: open. The `wait` half of the decision is **settled** (below); the `jobs` half is not.
Consolidated 2026-08-15 from `jobs-list-structured-output.md` plus the exit-code residue of #307
items 2 and 3.

## The concept that is missing

One structured output surface. Without it, two things that were built for people to read have become
protocols: `wait`'s exit integer, and the `jobs` table's column layout.

### Evidence that these are one problem, not two that resemble each other

`toExitCode` (`src/cli/follow.ts:201-214`) maps a job's terminal outcome onto `wait`'s own exit code and
passes a provider's status through `normalizeExitCode` across the full 0–255 range. Coral separately
reserves **75** for "still running" (`src/cli/errors.ts:98`).

A reserved code and a 0–255 passthrough cannot coexist — every value the reservation could take is a
value a child can produce. This is not hypothetical: **six** skill documents already carry the
workaround in prose.

> `ralph/SKILL.md:176` — "classify each result from its rendered output, **not exit code `75` alone** …
> even when a terminal `provider_exit` propagated code `75`."

The same sentence appears in `analyze` (`:65`), `bugfix` (`:27`), `code-simplify` (`:69`, plus a second
phrasing at `:75`), `preplan` (`:151`), `plan` (`:161`), and twice in `ralph` (`:176`, `:205`) — eight
sites across six documents. Six documents instructing agents to ignore the exit code is the system
reporting that the channel is full.

Exit 1 is overloaded the same way: it means both "your job failed" (`toExitCode`) and "I could not
attach to your job" (`scope_mismatch` reaching `errorCodeToExit`'s default).

The `jobs` table has the identical shape one level up: its column arity changes with the data
(`src/cli/format/jobs.ts`), and because each project section decides independently, one invocation can
print both a four-column and a five-column table.

## Settled: `wait` becomes a pure monitor

**The exit code describes the monitor, not the job.**

- The monitor did its work → **0**. Whether the job failed, or the bounded return fired with the job
  still live. Reporting a failure accurately is success.
- The monitor could not do its work → **non-zero**. It never attached, or the transport broke.

The job's outcome moves to the structured record, where it can carry more than eight bits.

**What this settles for free.** `scope_mismatch` exits 1 today, and under this model that is _already
correct_ — the monitor failed to attach. #307 item 2 therefore reduces to message quality: say what to
do instead of surfacing a raw 403. No exit-code change is needed for it.

**What it costs.** `toExitCode`'s outcome mapping goes away, and every skill that branches on it must
move to the structured record — all six named above, not the three an earlier revision listed.

**Binding constraint.** This must not ship before the build-identity work's **output** direction. A
session holding the old skill's text against a new CLI would read the new always-zero exit as
"everything succeeded" — silently converting failure into success, which is the worst available
failure direction. See `build-identity-and-upgrade.md`; note that its shipped half (#316) is the other
direction and does not lift this.

**Bonus the same change should carry.** A monitor should be able to show what has happened so far
without waiting for a bound. If the structured surface is a read rather than only a stream, that falls
out of the same work.

## Not settled: is the `jobs` table a contract?

Two branches, and the choice is a product decision:

1. **Stable tabular contract.** Fix the column schema including empty slot cells; treat headers, order
   and arity as compatibility surface; add fixtures proving project sections cannot choose different
   arities.
2. **Human-only table plus a structured mode.** Document the table as presentation, not a parsing
   contract, and add a separately named structured mode whose records are schema-validated.

The HTTP `/jobs` response is already structured, so the gap is the CLI surface specifically. The mode
name, encoding, versioning and error behaviour are all part of the decision.

## Ship as two PRs, never one

`wait` is a `subscribe` route: its structured form is a per-event record on a live stream. `jobs` is a
`servedRead`: its structured form is one envelope. Merging them means a single PR touches the
subscription protocol, the list formatter, and every skill that reads an exit code. Decide once, ship
twice.

Terminal width is a **third** thing and must not join either — see `cli-terminal-width-layout.md`. Width
work rewrites the very rows a contract fixture exists to freeze, and merged, a truncation regression and
a contract regression are indistinguishable in one diff.

## Start condition

The `wait` half needs `build-identity-and-upgrade.md`'s **output** direction answered — not its first
half, which shipped as #316 and addressed the unrelated record direction. The hazard here is a live
session holding the old skill's text against a new CLI, and nothing addresses it yet. It also needs the
skill branches inventoried before `toExitCode` is removed. The `jobs` half needs the CLI owner to pick a branch.
