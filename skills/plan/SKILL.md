---
name: plan
description: Claude-native planning with parallel architect/critic self-review
argument-hint: "[task description]"
---

# Planning

Execute a multi-round planning session with architect/critic review.

## Execution

1. **Load protocol**: Read `agents/planner.md` to load the full planner protocol
2. **Configure reviewers**: Use `coral:architect` and `coral:critic` as reviewers (full review loop, up to 5 rounds)
3. **Execute protocol**: Follow the planner protocol steps (gather context, write plan, review loop until no CRITICAL/HIGH, completion)
4. **Project validation**: If project instructions define workflow rules (e.g., review gates, post-implementation steps), follow them. If validation fails, revise the plan to address the issues and re-validate until it passes.
5. **Present plan**: Show the final plan to the user

## Context Enhancement

From the current conversation, identify and include:
- Task description and acceptance criteria
- File paths and code sections relevant to the plan
- Constraints or preferences stated by the user

## Error Policy

If `agents/planner.md` cannot be read, report the error to the user.
