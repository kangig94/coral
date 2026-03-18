# LLM Instruction Fragility Across Compaction Boundaries

## Rule
High-stakes behavioral constraints (e.g., "no session continuity in review rounds") degrade after conversation compaction — the model may resume violating the rule even when it was correctly followed before compaction. Place critical instructions redundantly: both in the narrative protocol section AND in Constraints/Failure-Modes tables. Generic error messages compound the problem by steering the model toward a wrong recovery path.

## Why
Compaction summarizes prior conversation but can flatten nuanced constraints into less specific abstractions. If the constraint appears only once in a prose paragraph, it may not survive compaction with full fidelity. After compaction, the model follows the summary, which may omit the specifics. Additionally, if the resulting error message is generic (e.g., "Session not found. Use exec.") rather than action-specific ("omit session for coral:* ops"), the model is misled into a different wrong behavior during error recovery.

## Pattern
```markdown
# WRONG — constraint appears only in prose:
"In multi-round review loops, do not pass session continuity."
# After compaction: constraint silently dropped, reviewer uses session across rounds

# RIGHT — redundant placement:
## Protocol
Step 4: Parallel review. Spawn both reviewers fresh (no session parameter).

## Constraints
| DO | DON'T |
|----|-------|
| Spawn fresh Codex session each review round | Pass session parameter to reviewer |

## Failure Modes to Avoid
- Session continuity across review rounds: "I'll pass session X for efficiency." → evaluates with prior bias

# ALSO RIGHT — action-specific error messages:
# WRONG error: "Session not found: use exec with session parameter"
# RIGHT error: "Session not found: for coral:* ops, omit session entirely — each agent spawns fresh"
```

Mitigations applied in coral: CRITICAL tag + code block examples without `session` in plan skill, plus coral:*-specific error message directing to omit session.
