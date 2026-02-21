---
name: coplan
description: Collaborative planning with parallel Codex architect/critic reviews
argument-hint: "[task description]"
---

# Collaborative Planning

Execute a multi-round planning session with Codex review followed by Claude cross-review.

## Execution

0. **Enter plan mode**: Call `EnterPlanMode` before any other work.
1. **Load protocol**: Read `agents/planner.md` to load the full planner protocol. **You** execute it directly - do NOT spawn a planner agent.
2. **Configure multi-phase review**:
   - Phase 1 reviewers: `coral:codex-proxy` with `Role: architect` and `coral:codex-proxy` with `Role: critic` (full review loop, up to 5 rounds)
   - Phase 2 cross-reviewers: `coral:architect` and `coral:critic` (single verification pass + one retry)
   - Only reviewers are spawned as subagents.
3. **Execute protocol**: Follow the planner protocol steps yourself with multi-phase review
4. **Project validation**: If project instructions define workflow rules (e.g., review gates, post-implementation steps), follow them. If validation fails, revise the plan to address the issues and re-validate until it passes.
5. **Present plan**: Call `ExitPlanMode` to present the final plan for user approval.
6. **Execution handoff**: After approval, use `AskUserQuestion` to let the user choose:
   - `/ralph` (Claude-native execution)
   - `/codex-ralph` (Codex delegation)
   - End planning (exit plan mode only, no execution)
   If an execution method is chosen, immediately invoke that skill.

## Context Enhancement

From the current conversation, identify and include:
- Task description and acceptance criteria
- File paths and code sections relevant to the plan
- Working directory for Codex agents
- Constraints or preferences stated by the user

## Error Policy

If `agents/planner.md` cannot be read, report the error to the user.
