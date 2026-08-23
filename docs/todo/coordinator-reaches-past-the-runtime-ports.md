# The invariant that forbids ambient I/O does not scan where the newest I/O landed

**Status**: open. Found by a review of PR2 of `backend-routing-disposition`, deliberately left unfixed there
because the answer is a module relocation and that PR is about routing dispositions.

## What exists

Principle 4 in `.claude/rules/design-philosophy.md` is Single Runtime World: backend I/O flows through the
Runtime ports selected at composition, and domains receive storage, time, paths, process, ids and env through
ports instead of reading ambient state. `tests/invariants/no-domain-ambient-io.test.ts` enforces it
structurally, and it works — it caught a bare-global `setTimeout` in a coordinator module during this same PR.

It enforces it **where it looks**, and that is the finding. The constant is

```
SCOPED_ROOTS = ['src/kb', 'src/providers', 'src/jobs', 'src/store']
```

for the `node:fs` / `node:os` / `node:child_process` / `node:crypto`-randomness scan, while the timer scan uses
a different and wider list that does include `src/coordinator`. That asymmetry is why one violation was caught
and the other was not: a coordinator module may import `node:fs` and nothing objects.

`node:sqlite` is in neither list, at any layer.

## The instance

`src/coordinator/handoff-routing-status.ts` reaches `node:fs` for `mkdirSync` and `chmodSync`, `node:sqlite`
for the database, and `node:crypto` — while its public publisher takes a time port and a raw path. So the
module receives one port and bypasses the rest.

The reviewer's stated consequence is the one that matters, because it is reachable rather than theoretical:
when PR3 drives this through a simulation or test runtime backed by in-memory storage, publication will not go
through that runtime. It will write to the host filesystem, and the simulation will report success.

## Two separable questions, and the second is not obvious

**The scan scope is mechanical.** Adding `src/coordinator` to `SCOPED_ROOTS`, and `node:sqlite` to the scanned
module set, makes the rule cover the layer where persistence work now lives. Expect it to fail loudly on
existing code, and expect some of those failures to be legitimate composition roots that need naming as
exemptions — the invariant already carries one for the claude appserver subprocess bootstrap.

**Where the module belongs is a real decision.** Three ownership rules in the Source Tree Policy touch it at
once: SQLite schema and append belong to the store layer; the coordinator composes owners and must not become
the vocabulary or persistence owner; and domains own their event vocabulary and read contracts. The module
today holds all three roles plus filesystem mutation. Splitting it along those lines is the structurally right
answer and it is not a small change, which is exactly why it is recorded rather than done.

Note what should not happen: routing the filesystem calls through `runtime.storage` while leaving `node:sqlite`
ambient would satisfy the invariant as it stands and change nothing about the reachable defect, because the
database is what the simulation runtime cannot intercept.

## Also noticed while reading it

The invariant's own header comment says it scans "`src/kb/`, `src/providers/`, and `src/jobs/`" while
`SCOPED_ROOTS` lists four roots. The comment describes the constant beneath it and has already drifted from
it — an instance of exactly what the comment rule in `.claude/rules/conventions.md` predicts. Whoever widens
the scope should delete that sentence rather than extend it.

## Start condition

Before PR3 of `backend-routing-disposition` activates a production caller, because that is when the bypass
becomes reachable through the simulation runtime rather than a latent property of an inert module. The scan
widening can go first on its own and will produce the inventory the relocation decision needs.
