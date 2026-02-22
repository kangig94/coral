---
name: init-project
description: Initialize project for AI-assisted development with rules, agents, CLAUDE.md, and docs
argument-hint: "[existing|new]"
---

# Project Initialization

Set up a project for AI-assisted development. Scans the project, plans appropriate artifacts with architect/critic review, then generates everything.

## Execution

1. **Load protocol**: Read `agents/init-project.md` for the full orchestration protocol. **You** execute it directly - do NOT spawn an init-project agent. The protocol spawns reviewers and ralph as subagents, which requires depth 0.
2. **Execute protocol**: Follow the 4-phase protocol yourself (Scan → Plan → Execute → Report). Only reviewers and ralph are spawned as subagents.
3. **Verify output**: Run Output Manifest check below
4. **Present results**: Show the final report to the user

## Output Manifest Verification (after Phase 3.5)

After ralph completes and Phase 3.5 verification passes, confirm these files exist with correct content. Missing files or failed content checks indicate protocol failure.

| Category | File | Condition | Content Check |
|----------|------|-----------|---------------|
| Hub | `.claude/CLAUDE.md` | Must exist (created or pre-existing) | Quality principle line present |
| Rules | `.claude/rules/agents.md` | Must exist | - |
| Rules | `.claude/rules/design-philosophy.md` | Must exist | - |
| Rules | `.claude/rules/validation.md` | Must exist | - |
| Rules | `.claude/rules/conventions.md` | Must exist | - |
| Rules | `.claude/rules/{domain-specific}.md` | At least 1 per detected domain | `paths:` frontmatter, no `{placeholder}` text |
| Agents | `.claude/agents/review-orchestrator.md` | Must exist | `<Agent_Prompt>` XML structure |
| Agents | `.claude/agents/code-critic.md` | Must exist | Rubric anchors (10/7/4/1) |
| Template | `.claude/templates/AGENT.md` | Must exist | - |
| Agents | `.claude/agents/{domain-specific}.md` | Per plan | `<Agent_Prompt>` XML structure |
| Docs | `docs/ARCHITECTURE.md` | If generated | Layer diagram present |
| Docs | `docs/DEV_GUIDE.md` | If generated | Exact build/test commands |
| KB | `.claude/coral/kb/` | Directory must exist | - |
| Git | `.gitignore` contains Coral block | Must contain `# Coral` | - |

If any required file is missing or fails its content check, report it as an error.
