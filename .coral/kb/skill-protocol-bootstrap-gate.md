# Protocol Bootstrap Steps Need Hard Gates

## Rule
When a skill protocol has a numbered bootstrap step (e.g. "Step 1: determine execution mode"), LLMs will skip it and jump to habitual behavior (codebase analysis, file reads, planning) unless the step is enforced with an explicit hard gate that prohibits other tool calls until the step completes.

## Why
LLMs have a strong prior toward "understand the problem first" — reading files, exploring code, gathering context. A numbered step buried inside a `<Protocol>` block competes with this prior and loses. The result: the bootstrap step is skipped entirely, and the LLM only realizes it when called out.

## Pattern

**Wrong** — bootstrap step is just another numbered item in `<Protocol>`:
```
<Protocol>
1) Determine execution mode.
   ...check state file, decide prompt vs plan mode...
2) Break work into steps.
3) Execute.
</Protocol>
```
LLM reads the protocol, then immediately starts reading source files.

**Right** — hard gate before any work:
```
<Protocol>
⛔ HARD GATE: Complete Step 1 BEFORE any file reads, searches, or analysis.
No tool calls except state file lookup until execution mode is determined.

1) Determine execution mode.
   ...
</Protocol>
```
Or: extract Step 1 into a separate `<Bootstrap>` section before `<Protocol>`.
