---
name: init-project
description: Initialize project for AI-assisted development with rules, agents, CLAUDE.md, and docs
argument-hint: "[existing|new]"
disable-model-invocation: true
---

# Project Initialization

Set up a project for AI-assisted development. Scans the project, plans appropriate artifacts with architect/critic review, then generates everything.

## Execution

1. **Load protocol**: Read `agents/init-project.md` for the full orchestration protocol. **You** execute it directly - do NOT spawn an init-project agent. The protocol spawns reviewers and ralph as subagents, which requires depth 0.
2. **Execute protocol**: Follow the 4-phase protocol yourself (Scan → Plan → Execute → Report). Only reviewers and ralph are spawned as subagents.
3. **Verify output**: Run Output Manifest check below
4. **Present results**: Show the final report to the user

## Output Manifest Verification (after Phase 4)

After ralph completes, verify these files exist. Missing files indicate protocol failure.

| Category | File | Condition |
|----------|------|-----------|
| Hub | `.claude/CLAUDE.md` | Must exist (created or pre-existing) |
| Rules | `.claude/rules/agents.md` | Must exist |
| Rules | `.claude/rules/design-philosophy.md` | Must exist |
| Rules | `.claude/rules/validation.md` | Must exist |
| Rules | `.claude/rules/conventions.md` | Must exist |
| Rules | `.claude/rules/{domain-specific}.md` | At least 1 per detected domain |
| Agents | `.claude/agents/review-orchestrator.md` | Must exist |
| Agents | `.claude/agents/code-critic.md` | Must exist |
| Agents | `.claude/agents/TEMPLATE.md` | Must exist |
| Agents | `.claude/agents/{domain-specific}.md` | Per plan |
| KB | `.claude/coral/kb/` | Directory must exist |
| Git | `.gitignore` contains Coral block | Must contain `# Coral` |

If any required file is missing, report it as an error.
