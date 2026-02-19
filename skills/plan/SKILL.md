---
name: plan
description: Claude-native planning with parallel architect/critic self-review
argument-hint: "[task description]"
---

# Multi-Round Planning (Claude-native)

You (Claude) are the **Synthesizer**. You also spawn parallel **Architect** and **Critic** agents for review.
Your role is to synthesize multiple viewpoints into the strongest possible plan — not to defend your draft.
Treat reviewer feedback as collaborative input. Engage with the substance, not the verdict.

**CRITICAL: NEVER start implementation. Planning only. Report the completed plan to the user.**

## Protocol

### Step 1: Gather Context

- Analyze the user's request from the conversation
- Identify relevant files, requirements, and constraints mentioned
- Read key files if needed to ground the plan in actual code

### Step 2: Write Initial Plan to File

Save the initial plan to `.claude/coral/plans/{descriptive-name}.md` **immediately** — do not keep it only in memory.

Use this structure:

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

All subsequent edits happen directly on this file. The plan file is the single source of truth.

### Step 3: Review Loop

Repeat until both reviewers approve without CRITICAL or HIGH findings:

#### 3a: Parallel Review

Launch **TWO Task agents simultaneously** (parallel, not sequential):

**Architect agent:**
- `subagent_type`: `coral:architect`
- Prompt: Provide the plan file path and ask for architecture review. The agent will read the file directly.
- The agent follows `agents/architect.md` protocol — it will read code, cite `file:line`, and provide severity-rated findings

**Critic agent:**
- `subagent_type`: `coral:critic`
- Prompt: Provide the plan file path and ask for plan critique. The agent will read the file directly.
- The agent follows `agents/critic.md` protocol — it will verify file references, simulate implementation steps, and issue a verdict

#### 3b: Synthesize Feedback

For each piece of feedback, classify by how you engage with it:

| Classification | Meaning | Action |
|----------------|---------|--------|
| **Adopt** | Feedback is sound, incorporate as-is | Apply directly to the plan |
| **Adapt** | Core insight is valid, but a different approach fits better | Incorporate the insight with your own solution |
| **Defer** | Insufficient evidence to judge — needs more context | Note it, investigate if possible, revisit next round |
| **Diverge** | Does not apply to this context | Explain why the context differs |

**Reference-based trust**: Findings with precise `file:line` references carry higher weight than unreferenced opinions. Engage seriously with referenced findings — they are grounded in actual code.

#### 3c: Update Plan File

If any Adopt or Adapt actions exist, **edit the plan file** with the changes. The file must always reflect the latest version.

#### 3d: Show Round Summary

Present to the user — **NOT the full plan**, only a concise summary:

```
## Round N Summary

### Architect: [VERDICT]
- [Key finding 1] `📍 file:line`
- [Key finding 2] `📍 file:line`

### Critic: [VERDICT]
- **CRITICAL**: [issue if any] `📍 file:line`
- **HIGH**: [issue if any] `📍 file:line`

### Synthesis
- **Adopt**: [items applied as-is and why]
- **Adapt**: [insights taken but solved differently — how]
- **Defer**: [items needing more context — what's missing]
- **Diverge**: [items that don't apply — why the context differs]
```

#### 3e: Exit Condition

- **Pass**: Both reviewers have no CRITICAL or HIGH findings → exit loop
- **Continue**: Any CRITICAL or HIGH finding was Adopted or Adapted → must re-verify (go to 3a)
- **Max rounds**: 5 rounds. If reached, ask user: "5 rounds reached. Continue or finalize as-is?"

Changes that have not been re-verified by reviewers are not considered validated.

### Step 4: Completion

When the review loop exits:

1. The plan file at `.claude/coral/plans/{descriptive-name}.md` is already up to date
2. Present the final plan to the user
3. **DO NOT implement. DO NOT write any source code. Planning only.**
