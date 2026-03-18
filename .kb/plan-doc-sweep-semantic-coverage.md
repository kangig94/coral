# Plan Doc Sweep Must Cover Semantic Recovery Patterns
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
When a plan narrows or removes a caller contract, do not scope the documentation sweep or grep-based verification only to the old API token names. Include semantically equivalent examples that teach the same recovery behavior through hard-coded paths or alternate phrasing, and name every user-facing doc surface that still carries that behavior.
## Why
A narrow grep gate can report a false clean sweep while an adjacent doc still teaches the retired contract in different words. In the wait path-first redesign, the plan already targeted `inline`, `Read(result.content)`, and universal `result.content ?? Read(result.path)` guidance, but `docs/architecture.md` still taught `wait({ jobs: [job] }) + Read(/tmp/coral-jobs/<jobId>/result.md)`. That direct artifact-path example encoded the same universal provider-safe fallback the redesign was supposed to narrow, so the plan needed both an explicit file target and a broader verification pattern.
## Pattern
Right:
```text
Phase 5 docs: docs/mcp-tools.md, docs/core-modules.md, docs/architecture.md
Verification: docs/skills now teach:
- workflow: wait({ jobs: [job] }) then result.content ?? Read(result.path)
- provider: wait({ jobs: [job] }) then prefer result.content; treat result.path as best-effort recovery
And no docs/skills still teach:
- Read(result.content) as the path-mode pattern
- Read(/tmp/coral-jobs/<job>/result.md) after wait()
- universal result.content ?? Read(result.path) for provider jobs
```

Wrong:
```text
Phase 5 docs: docs/mcp-tools.md, docs/core-modules.md
Verification: grep only for legacy token names and assume the remaining wait examples follow the path-first contract
```
