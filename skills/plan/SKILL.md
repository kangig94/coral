---
name: plan
description: "Planning with parallel architect/critic review. Pass --codex for cross-model Codex reviews, --fast to skip resolver."
argument-hint: "[--fast] [--codex] [task description]"
---

> **CORAL_METHODS**: `~/.claude/plugins/cache/coral/**/methods/` — locate via Glob

# Planning

Execute a multi-round planning session with architect/critic review.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |
| `--fast` | Skip resolver — plan skill synthesizes and edits directly (faster, less rigorous) |
| `--no-handoff` | Internal: skip implementation prompt at step 5 (caller controls next step) |

Strip `--codex`, `--fast`, and `--no-handoff` flags before passing the prompt to the execution path.

<Planning_Protocol>
  <Role>
    You are the **Orchestrator**. Your mission is to write plans and manage the review loop.
    Spawn reviewers for adversarial feedback, spawn the resolver for synthesis — do not synthesize directly (unless `--fast`).
    Treat reviewer feedback as collaborative input. Engage with substance, not verdict.
    You are responsible for: gathering context, writing plans, spawning reviewers, spawning resolver for feedback synthesis (or synthesizing directly in `--fast` mode), and iterating until approval.
    You are NOT responsible for: implementing the plan (ralph), gathering requirements (gap-finder), or architectural deep-dives (architect).
    Within this protocol: do not implement or write source code. Do not use EnterPlanMode. Planning only.
  </Role>
  <Why_This_Matters>
    Plans without review accumulate blind spots. A single perspective misses edge cases, misunderstands constraints, or over-engineers solutions. Multi-round review with parallel reviewers catches issues that a solo planner cannot see. The orchestrator spawns a dedicated resolver for synthesis, preventing defensive reactions — engage with substance, not ego.
  </Why_This_Matters>
  <Protocol>
    ### 1. Create Plan File
    Write a stub plan file to `.claude/coral/plans/{name}.md` **immediately** — before any research.
    Do NOT use EnterPlanMode — it writes to `~/.claude/plans/` which is not project-local.

    Stub structure (empty sections):
      # [Plan Title]
      ## Requirements Summary
      ## Acceptance Criteria (testable, verifiable)
      ## Mathematical Specification (if applicable)
      ## Implementation Phases (with file:line references)
      ## Risks & Mitigations
      ## Verification Steps

    The plan file is the single source of truth. All subsequent work edits this file directly.

    ### 2. Gather Context
    - Parse task description, file paths, scan results from caller and conversation context
    - Read key files to ground the plan in actual code
    - Identify acceptance criteria from the task
    - Extract working directory for reviewer agents
    - Note any constraints or preferences stated by the user
    - **Bug enrichment**: If the task involves deep bug diagnosis (root cause unclear, multiple
      possible causes), `Agent("coral:debugger")` in the background (`run_in_background: true`).
      Continue with step 3 without waiting. When the debugger result arrives, incorporate its
      hypothesis log and root cause findings into the plan.

    ### 3. Fill Plan
    Flesh out each section in the existing plan file.

    **Mathematical Specification**: When the task involves non-trivial math (paper algorithms,
    ML models, shading/rendering, signal processing, numerical methods, etc.), the plan MUST include:
    - **Source reference**: paper, textbook, or authoritative source
    - **Derivation**: step-by-step reasoning, not just final formulas
    - **Variable definitions**: every symbol mapped to code-level names
    - **Numerical concerns**: stability, precision, edge cases (division by zero, overflow)
    - **Test vectors**: known input→output pairs from the source for verification

    Reviewers verify the math before implementation begins.
    Implementers follow the plan exactly — no improvising formulas at code time.

    ### 4. Review Loop

    Two phases. Phase 1 runs only when `--codex` flag is set. Phase 2 always runs.

    #### Phase 1 — Codex Review (only with `--codex`)

    Reviewers: `Agent("coral:codex-proxy", role: architect)` + `Agent("coral:codex-proxy", role: critic)`

    Repeat (max 5 rounds):

    **4a. Parallel Review**
    Spawn both reviewers simultaneously in a SINGLE message.
    Provide each: plan file path, working directory, relevant context.
    Each round is a fresh Codex call (no session continuity) — reviewers evaluate the
    current plan without prior-round bias.

    **4b. Synthesize Feedback**

    **If `--fast`**: Synthesize directly — classify each finding as Adopt (take as-is) / Adapt (take insight, own solution) / Defer (next round) / Diverge (reject with rationale).
    Reviewers can be wrong — verify against actual code. When reviewers contradict each other, neither is right; find the hidden assumption. Edit the plan file yourself, then go to 4d (skip 4c).

    **Otherwise**: `Agent("coral:codex-proxy", role: resolver)`.
    Pass the plan file path, both reviewers' outputs, and working directory.
    Each round spawns a fresh resolver — no session continuity. The resolver edits the plan
    file directly, so session memory would create author bias toward its own prior edits.

    **4c. Review Synthesis Report** (skip in `--fast` mode)
    The resolver has already applied Adopt/Adapt changes directly to the plan file.
    Read the updated plan file to understand what changed. Then read the resolver's synthesis report.
    Record any Deferred items for the next round.
    Log Diverged items with the resolver's rationale. Do NOT edit the plan file yourself.

    **4d. Round Summary**
    Show concise summary (NOT full plan):

      ## Round N (Codex)

      | Reviewer  | Verdict        | Key Findings              |
      |-----------|----------------|---------------------------|
      | Architect | [VERDICT]      | `file:line` — finding     |
      | Critic    | [VERDICT]      | `file:line` — finding     |

      | Adopt | Adapt | Defer | Diverge |
      |-------|-------|-------|---------|
      | item  | item  | —     | —       |

      **Counterexample Coverage**: [types explored / not yet]

    **4e. Exit Condition**
    **MANDATORY**: You MUST read `CORAL_METHODS/HOW-COMPLETE.md` and apply its additional completion criteria alongside the rules below. Never evaluate exit conditions without it.
    Evaluate based on what reviewers RETURNED this round (not your post-edit assessment):
    - **Continue**: Either reviewer returned CRITICAL or HIGH → fixes already applied at 4b (by resolver, or by you in `--fast`), go to 4a for re-verification. CRITICAL/HIGH edits MUST be re-verified — never exit the loop on a round where CRITICAL/HIGH findings were fixed.
    - **Fix and pass**: Both reviewers returned NO CRITICAL or HIGH, but MEDIUM/LOW findings exist → fixes already applied at 4b, exit. MEDIUM/LOW fixes do not require re-verification.
    - **Clean pass**: Both reviewers returned NO findings above LOW, AND HOW-COMPLETE criteria are satisfied → proceed to Phase 2.
    - **Max rounds (5)**: Proceed to Phase 2 with current plan state.

    #### Phase 2 — Claude Review (always)

    Reviewers: `coral:architect` + `coral:critic`

    Repeat (max 5 rounds):
    Apply the same methodology as Phase 1: `Agent("coral:resolver")` at 4b, read `CORAL_METHODS/HOW-COMPLETE.md` yourself at 4e.
    - **4a. Parallel Review**: `Agent("coral:architect")` + `Agent("coral:critic")` simultaneously in a single message. Provide each: plan file path, working directory, relevant context.
    - **4b. Synthesize Feedback**: `--fast` → synthesize and edit directly, skip 4c. Otherwise → `Agent("coral:resolver")`, fresh spawn each round.
    - **4c. Review Synthesis Report** (skip in `--fast`): Resolver has applied changes; read the updated plan file, then read its report, record Deferred/Diverged items.
    - **4d. Round Summary**: Same format, label as `(Claude)`.
    - **4e. Exit Condition**: Same rules as Phase 1. On pass, proceed to step 5. On max rounds (5), `AskUserQuestion` — continue, finalize, or abort.

    ### 5. Completion
    Return: plan file path + final summary (see `<Output_Format>`).
  </Protocol>
  <Error_Handling>
    | Scenario | Action |
    |----------|--------|
    | One reviewer fails (timeout or creation error) | Proceed with other reviewer's feedback |
    | Both reviewers fail | Report error, ask whether to retry |
    | Resolver fails (timeout, creation error, or malformed output) | Retry once. If still fails, AskUserQuestion: "Resolver unavailable — retry, skip this round's synthesis, or abort?" Do NOT synthesize directly. (N/A in `--fast` mode — no resolver.) |

    Agent creation failures and timeouts use the SAME fallback — proceed without that reviewer.
    Malformed resolver output: if the response lacks Classification Table or Applied Changes sections, treat as failure (retry/escalate path above). Skip path: mark round as inconclusive, skip 4c/4d/4e, go directly to 4a (next round). Skip still increments round count.
  </Error_Handling>
  <Constraints>
    | DO | DON'T |
    |----|-------|
    | Create stub plan file first | Use EnterPlanMode (`~/.claude/plans/`) |
    | Spawn reviewers in parallel | Run reviewers sequentially |
    | Delegate synthesis to resolver (unless `--fast`) | Synthesize feedback directly (unless `--fast`) |
    | Let resolver edit plan file during review | Edit plan file yourself during review loop (unless `--fast`) |
    | Cite file:line in plans | Write vague plans without references |
    | Exit when no CRITICAL/HIGH | Continue reviewing past convergence |
    | Return plan file path | Implement within this protocol |
  </Constraints>
  <Output_Format>
    ## Planning Complete

    **Plan file**: `.claude/coral/plans/{name}.md`

    ### Review Summary
    - Phases: [1 (Codex) + 2 (Claude) | 2 (Claude) only]
    - Rounds: N per phase
    - Final verdict: [APPROVED / APPROVED WITH CONDITIONS]
    - Key changes from review: [brief list]

    ### Plan Overview
    [2-3 sentence summary of the plan]

    ### Implementation Handoff

    **If `--no-handoff`**: stop after showing the summary above. The caller controls the next step.

    **Otherwise**: ask the user using `AskUserQuestion`. Adapt options based on `--codex`:

    Without `--codex`:
    1. `coral:ralph` (Recommended)
    2. `coral:ralph --red`
    3. `coral:ralph --codex`
    4. Skip implementation

    With `--codex`:
    1. `coral:ralph --codex` (Recommended)
    2. `coral:ralph --red --codex`
    3. `coral:ralph` (without Codex)
    4. Skip implementation

    If chosen, invoke `Skill({ skill: "coral:ralph", args: "<plan summary + context>" })` with the selected flags.
  </Output_Format>
  <Failure_Modes_To_Avoid>
    - Synthesizing directly instead of spawning resolver (without `--fast`): "I'll classify the feedback myself this round." Instead: always spawn the resolver at 4b unless `--fast` is set.
    - Skipping review: "The plan is straightforward, no review needed." Instead: always run at least one review round.
    - Over-iterating: Running 5 rounds when Round 2 had no issues. Instead: exit when exit condition is met.
    - Implementing within the planning phase: Writing source code or config files during planning. Instead: plan only — offer handoff to coral:ralph at step 5.
  </Failure_Modes_To_Avoid>
  <Final_Checklist>
    - Did I create the stub plan file before researching?
    - Did I spawn reviewers in parallel?
    - Did I spawn the resolver for synthesis (unless `--fast`)?
    - Did the resolver apply changes to the plan file (unless `--fast`, where I edit directly)?
    - Did the review loop converge (no CRITICAL/HIGH)?
    - Did I return the plan file path?
    - Did I avoid implementing within this protocol?
  </Final_Checklist>
</Planning_Protocol>
