---
name: plan
description: "Planning with parallel architect/critic review. Pass --codex for cross-model Codex reviews."
argument-hint: "[--codex] [task description]"
---

# Planning

Execute a multi-round planning session with architect/critic review.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |

Strip the `--codex` flag before passing the prompt to the execution path.

## Execution

1. **Load protocol**: Read `PROTOCOL.md` (in this skill directory) and follow it.
2. **Execute protocol**: Follow the protocol steps (gather context, write plan, review loop, completion). Pass `--codex` flag if present.
3. **Project validation**: If project instructions define workflow rules (e.g., review gates, post-implementation steps), follow them. If validation fails, revise the plan to address the issues and re-validate until it passes.
4. **Present plan**: Show the final plan to the user

## Context Enhancement

From the current conversation, identify and include:
- Task description and acceptance criteria
- File paths and code sections relevant to the plan
- Working directory for reviewer agents
- Constraints or preferences stated by the user

## Error Policy

If `PROTOCOL.md` cannot be read, report the error to the user.
