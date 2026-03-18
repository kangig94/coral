# Resolver May Violate Pre-plan Scope Constraints — Orchestrator Must Diverge

## Rule
When using `--deep` planning, the Codex resolver applies findings mechanically without checking
them against the pre-plan scope. If a reviewer proposes a structural change that violates a
user-stated constraint (e.g., "hook-only, no API changes"), the orchestrator must explicitly
diverge from that finding with a rationale, revert any changes the resolver applied, and record
the divergence in the round summary.

## Why
The resolver's job is to synthesize reviewer findings into plan edits — it does not have access
to the pre-plan agreement or the user's stated exclusions. A HIGH-severity "improvement" from an
architect reviewer can cause the resolver to introduce backend endpoints, new source files, or
other out-of-scope changes. Accepting these silently breaks the plan's scope contract and
invalidates the user's architectural decision.

## Pattern
Right:
```
1. After resolver applies changes, read the updated plan
2. Compare against .claude/coral/plans/pre-{topic}.md Scope > Excluded section
3. If resolver introduced an excluded change → revert it, mark as Diverged in round summary
4. Continue with re-verification only for the structural HIGH findings that were NOT diverged
```

Wrong:
```
1. Resolver applies a backend endpoint (violates "hook-only" constraint)
2. Orchestrator accepts because the reviewer rated it HIGH
3. Plan now includes src/ changes the user explicitly excluded
```

Concrete example: Phase 1 Round 3 of `compaction-job-recovery` plan — Codex resolver replaced
the hook-based `/tmp` scan with `GET /internal/live-jobs` backend endpoint, correctly identified
as HIGH-severity scalability improvement but violating the pre-plan "no MCP API changes" exclusion.
The orchestrator reverted the change and diverged explicitly.
