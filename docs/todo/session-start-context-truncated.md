# TODO — the SessionStart packet is truncated, and the half that survives is the half that changes nothing

**Status**: open, top of the order, and measured rather than inferred. Every other entry in this directory
describes work the agent can choose to do. This one describes why the agent may never read the instructions
that would tell it how.

## What was measured

`clients/hooks/session-start.mjs` emits **11,320 bytes** in one `additionalContext` payload. The harness
persists a payload over its threshold to a file and shows the model only a preview of the **first 2 KB**,
with a note naming the full path. Measured on 2026-08-22 across three injections in one session (a fresh
start and two compactions): all three were persisted at exactly 11,320 bytes, so the packet is truncated
every time, not occasionally.

Two other SessionStart hooks inject alongside it — a codebase-memory "Code Discovery Protocol" block
(~0.7 KB) and a PARA-ZK vault block (~1.7 KB). **Neither is truncated.** They are separate payloads; nothing
is concatenated. Coral's is the only one over the threshold, and it is over by roughly five times.

The threshold for a hook payload is **bounded, not pinned**: above 1.7 KB (the largest observed inline) and
at or below 11,320 bytes (the smallest observed persisted). It is far lower than the tool-output threshold,
which the same session measured as above 25 KB (a 25,000-byte tool result arrived inline) and at or below
30,684 bytes (the smallest persisted tool result). Pinning the hook threshold needs a way to emit a
controlled-size `additionalContext`, which this investigation did not have.

## The packet is already in pieces

The payload is assembled from files that are each well under the whole:

| file | bytes |
|---|---|
| `clients/inject/core.md` | 3,943 |
| `clients/inject/kb/orchestrator.md` | 2,046 |
| `clients/inject/kb/session.md` | 1,750 |
| `clients/inject/kb/common.md` | 1,108 |
| `clients/inject/tools.md` | 893 |
| **assembled total** | **9,740** |

The remaining ~1,580 bytes are what `session-start.mjs` fills in at runtime — session id, host, path-alias
substitution, the wiki packet. So option 2 below is not a restructure: the seams already exist, and the
concatenation is the only reason any single payload is over the line. What it needs first is the threshold,
because `core.md` at 3,943 bytes sits inside the unpinned band and may or may not survive alone.

## Why the truncation is worse than its size

The 2 KB that survives is `# Coral Guidelines` §§1-3 — Think Before Coding, Clarity First, Surgical Changes.
That is general coding advice, and most of it restates what the host system prompt already says. A reader
who sees only the preview concludes the file is generic and does not open it.

Everything that changes behaviour is past the cut:

- `## 5. Stay Cold` — treat every failure, warning, and **injected reminder** as a signal; the correct
  response to something breaking near the finish line is stillness, not speed.
- `# Tools` — codebase-memory is the mandatory first stop for every code task, before grep, reads, edits,
  reviews or debugging; `CLI codex <agent>` resolves `.claude/agents/<name>.md` first, then Coral's bundled
  agents; the `CORAL_PROJECT/` and `CORAL_METHODS/` path aliases; sandbox bypass for Coral CLI calls.
- `# Knowledge Base` — pass `owner: "<session-id>"` to every provider and workflow call so child agents
  inherit session ownership; the memo, promotion and wiki contracts.

So the packet is ordered exactly backwards for its own delivery mechanism: what a reader can skip is what
survives, and what would change what the reader does is what disappears.

## Observed consequence

In the session that measured this, the orchestrator did not open the persisted file until asked directly,
late, after roughly two hundred tool calls. In that window it used grep as the first step for every code
task across three branches, delegated with a hand-written persona instead of `codex <agent>`, omitted
`owner:` from more than twenty provider and workflow calls, and expanded the path aliases by hand. Each is
a rule stated in the part that was cut. The failure needs no unusual conditions — reading the preview and
concluding it is generic is the expected behaviour, not a lapse.

## What would fix it

Three options, cheapest first. They are not exclusive.

1. **Reverse the order.** Emit `# Tools`, `## 5. Stay Cold` and the `owner:`/agent-resolution rules FIRST and
   the general guidelines last. Truncation then keeps the operative half. This is a reordering, costs nothing,
   and works even if the threshold changes.
2. **Split the payload.** A SessionStart hook may emit more than one `additionalContext`; the two sibling
   hooks prove separate payloads arrive whole, and the source files above are already separate. Emitting them
   as separate payloads rather than one concatenation puts each piece under the threshold — but only if the
   threshold is above `core.md`'s 3,943 bytes, which is not established.
3. **Shorten it.** §§1-4 of the guidelines are largely general coding advice that overlaps the host system
   prompt. Cutting them to what is Coral-specific may bring the whole packet under the threshold, which is the
   only fix that also removes the reader's incentive to skip it.

Whichever is chosen, the packet needs a **size assertion** — a test that fails when the emitted payload
exceeds a bound this repository picks and states, so the next addition cannot silently push the operative
half back over the line. Without it the fix regresses the first time someone appends a section.

## Not established here

The exact harness threshold, and whether it is a byte count, a token estimate, or host-version dependent.
The fix does not need it: a bound this repository chooses and asserts is sound whatever the harness uses,
as long as it is comfortably below the smallest value observed to truncate.

## Start condition

None. Option 1 is a reordering inside one file and blocks nothing.
