# Agent System

## Agent Quick Reference

| Agent | File | Model | Tier | Purpose |
|-------|------|-------|------|---------|
| integration-guardian | `.claude/agents/integration-guardian.md` | opus | 1 | CLI/backend contract compliance, schema validation |
| hook-safety | `.claude/agents/hook-safety.md` | sonnet | 2 | Hook timeout safety, Node.js ESM conventions |
| skill-quality | `.claude/agents/skill-quality.md` | sonnet | 2 | SKILL.md quality, frontmatter correctness |
| code-critic | `.claude/agents/code-critic.md` | sonnet | 3 | Code quality, elegance, complexity |
| doc-critic | `.claude/agents/doc-critic.md` | sonnet | 3 | Documentation quality, accuracy, structure |
| test-critic | `.claude/agents/test-critic.md` | sonnet | 3 | Test quality, coverage architecture, assertions |
| ux-critic | `.claude/agents/ux-critic.md` | sonnet | 3 | Plugin UX, skill discoverability, CLI ergonomics |

## Consultation Matrix

| Task Category | MANDATORY Consultations | RECOMMENDED Consultations | Reason |
|---------------|------------------------|---------------------------|--------|
| CLI/backend handler changes | integration-guardian | code-critic | Contract compliance is blocking |
| Zod schema changes | integration-guardian, code-critic | ux-critic | Schema correctness + API ergonomics |
| Hook script changes | hook-safety | code-critic | Timeout safety + Node.js ESM conventions |
| SKILL.md changes | skill-quality | ux-critic | Frontmatter correctness + discoverability |
| Agent definition changes | code-critic | -- | Agent system coherence |
| Session manager changes | integration-guardian, code-critic | -- | Atomic writes + error handling |
| Output parser changes | integration-guardian | code-critic | JSONL contract correctness |
| State machine changes | integration-guardian, code-critic | -- | Pure function correctness + discuss protocol |
| New CLI/backend surface addition | integration-guardian, ux-critic | code-critic | Contract + ergonomics + quality |
| Documentation changes | doc-critic | -- | Documentation accuracy + structure |
| Test changes | test-critic | code-critic | Test quality + coverage architecture |
| Any implementation complete | `Skill(tier-review)` | -- | Final validation gate (runs in main context, spawns agents) |

## Invocation Protocol

```
@<agent-name> <brief description of what to review>
```

Examples:
```
@integration-guardian Review schema validation in discuss server-handlers.ts
@hook-safety Check bash-rewrite.mjs for timeout safety
@skill-quality Validate frontmatter in clients/skills/discuss/SKILL.md
@code-critic Review elegance of state-machine.ts resolveWinner function
@ux-critic Check argument ergonomics for `coral-cli discuss start`
```

Provide file paths and specific concerns. Consult agents early (before implementation) for guidance and late (after implementation) for validation.

## Design Principles

### Fresh Context for Verification

When verifying work output, spawn a dedicated subagent instead of self-verifying.

**Why**: The producing agent accumulates context bias through planning, decision-making, and execution — it is predisposed to confirm its own output. A fresh subagent has no prior commitment to the result.

**Pattern**:
- Producer agent generates output (files, plans, code)
- Verifier subagent receives only: inputs (requirements, analysis) + outputs (generated files)
- Verifier has a single goal: do the outputs satisfy the inputs?
- One goal, clean context, higher accuracy

**Anti-pattern**: Agent generates artifacts → same agent "spot-checks" its own work → confirmation bias → defects pass through.

### Shared-Worktree Safety

Parallel review/guardian agents share one working tree but not commit isolation. A default Bash-capable agent that sees unfamiliar changes will try to "tidy up" with `git checkout` / `git stash` / `git reset` — silently reverting every sibling's in-progress work.

**Rule**: every prompt that spawns an agent into a shared worktree MUST forbid state-changing git. Reviewers are read-only — no `git checkout` / `switch` / `stash` / `reset` / `restore` / `clean`, no staging, no committing. To inspect another revision, use read-only git (`git diff <ref>`, `git show <ref>:<path>`, `git log <ref>`) instead of checking it out.

**Enforcement**: the `tier-review` skill embeds this guard in every Phase 3 spawn prompt. Any new parallel-spawn site (skills, orchestrators) MUST carry the same guard. A single `git checkout` in a shared tree reverts all concurrent agents' work — treat the omission as a defect, not a style choice.
