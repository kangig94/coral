---
name: plan
description: Collaborative planning with parallel Codex architect/critic reviews
argument-hint: "[task description]"
allowed-tools: mcp__coral__codex_execute, mcp__coral__codex_session_send
---

# Multi-Round Collaborative Planning

You (Claude) are the **Planner**. Codex provides parallel **Architect** and **Critic** reviews.
Your judgment is final — reviewers can make wrong critiques. Selectively incorporate valid feedback.

**CRITICAL: NEVER start implementation. Planning only. Report the completed plan to the user.**

## Protocol

### Step 1: Gather Context

- Analyze the user's request from the conversation
- Identify relevant files, requirements, and constraints mentioned
- Read key files if needed to ground the plan in actual code

### Step 2: Create Initial Plan

Write a structured plan with these sections:

```markdown
# [Plan Title]

## Requirements Summary
[What needs to be done and why]

## Acceptance Criteria
[Testable criteria — each must be verifiable]

## Implementation Phases
[Ordered phases with file:line references where applicable]

## Risks & Mitigations
[What could go wrong and how to handle it]

## Verification Steps
[How to confirm the plan was implemented correctly]
```

### Step 3: Parallel Review (Round 1)

Call `codex_execute` **TWICE simultaneously** (parallel, not sequential):

**Architect call:**
1. Read `agents/codex-architect.md` to load the architect protocol
2. Use the protocol's `<Prompt_Template>` to construct the Codex prompt
3. Include the full plan content as CONTEXT
4. Call `codex_execute` with the assembled prompt + `working_directory`

**Critic call:**
1. Read `agents/codex-critic.md` to load the critic protocol
2. Use the protocol's `<Prompt_Template>` to construct the Codex prompt
3. Include the full plan content as CONTEXT
4. Call `codex_execute` with the assembled prompt + `working_directory`

Both calls MUST include the `working_directory` parameter set to the project root.

**IMPORTANT**: Since raw thread_ids are used (not named sessions), `working_directory` is NOT stored automatically. You MUST pass `working_directory` on EVERY `codex_execute` and `codex_session_send` call throughout the entire planning process.

### Step 4: Evaluate Feedback

For each piece of feedback from both reviewers:

| Judgment | Action |
|----------|--------|
| Valid and critical | Incorporate immediately |
| Valid but minor | Incorporate if straightforward |
| Wrong or invalid | Reject with reasoning |
| Conflicting opinions | You (Claude) make the final call |

Remember: Your judgment overrides reviewer verdicts. Reviewers often make incorrect critiques.

### Step 5: Show Round Summary

Present to the user — **NOT the full plan**, only a concise summary:

```
## Round N Summary

### Architect: [VERDICT]
- [Key finding 1]
- [Key finding 2]

### Critic: [VERDICT]
- **CRITICAL**: [issue if any]
- **HIGH**: [issue if any]

### My Decision
- Incorporated: [items accepted and why]
- Rejected: [items ignored and why]
- Next: [whether another round is needed]
```

### Step 6: Iterate (Round 2+)

Use `codex_session_send` with the thread_ids from Step 3 to continue the same reviewer sessions:

```
Here is the updated plan. Changes from your previous feedback:
- [Change 1]: [incorporated / rejected with reason]
- [Change 2]: ...

Please review again, focusing on whether your previous concerns are addressed.

[UPDATED PLAN]
{full updated plan content}
```

Pass `working_directory` on every call. Each reviewer remembers their previous feedback via session continuity.

### Step 7: Max Rounds Handling

- **Default maximum**: 5 rounds
- If 5 rounds reached and still not satisfied:
  - Ask the user: "5 rounds reached. Continue for up to 5 more rounds, or finalize as-is?"
  - If user approves: reset round counter, continue with same threads
  - If user declines: finalize the current plan

### Step 8: Completion

When you are satisfied with the plan:

1. Save the final plan to `.claude/coral/plans/{descriptive-name}.md`
2. Present the complete plan to the user
3. **DO NOT implement. DO NOT write any source code. Planning only.**

## Error Handling

| Scenario | Action |
|----------|--------|
| Architect call fails, Critic succeeds | Proceed with Critic feedback only |
| Critic call fails, Architect succeeds | Proceed with Architect feedback only |
| Both calls fail | Report to user, ask whether to retry or proceed manually |
| One side hits rate limit | Report error, proceed with successful side only |
| Response contains `errors[]` | Treat as partial result, use available feedback |

## Result Presentation

When presenting Codex review results, follow standard error handling:

1. **Response only (no errors/warnings)**: Show the review content directly
2. **Response + errors**: Show response first, then note the error
3. **Errors only**: Report the error, skip that reviewer for this round
4. **Warnings**: Append as brief notes after the review content
