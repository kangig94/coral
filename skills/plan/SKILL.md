---
name: plan
description: "Planning with parallel architect/critic review. Pass --deep for methodology-driven synthesis, --codex for cross-model reviews."
argument-hint: "[--deep] [--codex] [task description]"
---

> **CORAL_METHODS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/methods/")`

# Planning

Execute a multi-round planning session with architect/critic review.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--deep` | Methodology-driven: spawn resolver (HOW-SYNTHESIZE), read HOW-COMPLETE, pass `--deep` to reviewers |
| `--no-handoff` | Internal: skip implementation prompt at step 5 (caller controls next step) |

Strip `--codex`, `--deep`, and `--no-handoff` flags before passing the prompt to the execution path.

<Planning_Protocol>
  <Role>
    You are the **Orchestrator**: write plans, dispatch reviewer workflows, synthesize feedback (or delegate to resolver in `--deep`), iterate until approval.
    Treat reviewer feedback as collaborative input — engage with substance, not verdict.
    Planning only — no source code, no EnterPlanMode, no implementation.
  </Role>
  <Protocol>
    ### 1. Create Plan File
    If invoked from preplan, `{topic}` is already defined. Otherwise, derive `{topic}` from the user's input as English kebab-case.
    Write a stub plan file to `.claude/coral/plans/{topic}.md` **immediately** — before any research.
    Do NOT use EnterPlanMode — it writes to `~/.claude/plans/` which is not project-local.

    Stub structure (empty sections) — copy headings verbatim including parenthetical annotations:
      # [Plan Title]
      **Preplan**: `.claude/coral/plans/pre-{topic}.md` (omit if no preplan exists)
      ## Requirements Summary
      ## Acceptance Criteria (testable, verifiable — register each as a Task during implementation)
      ## Mathematical Specification (if applicable)
      ## Implementation Phases (with file:line references)
      ## Risks & Mitigations
      ## Verification Steps

    Parenthetical annotations are instructions to the implementer who reads the plan file.
    The plan file is the single source of truth. All subsequent work edits this file directly.

    ### 2. Gather Context
    Parse task description, read key files, identify acceptance criteria, extract working directory.
    - **Preplan**: If `.claude/coral/plans/pre-{topic}.md` exists, read it.
      Extract the **Success Criteria** section — these are the acceptance criteria the plan must satisfy.
      Pass them to reviewers in step 4a.
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

    Three phases. Phase 0 always runs first. Phase 1 runs only when `--codex` flag is set. Phase 2 always runs.

    **Task registration**: Before starting Phase 0, register one Task per applicable phase:
    - `TaskCreate({ subject: "Phase 0 — Frame Gate" })`
    - `TaskCreate({ subject: "Phase 1 — Codex review" })` (only if `--codex`)
    - `TaskCreate({ subject: "Phase 2 — Claude review" })`

    On phase start: `TaskUpdate({ taskId, status: "in_progress" })`.
    On each round: `TaskUpdate({ taskId, subject: "Phase N — {label} (round M/5)" })`.
    On phase complete: `TaskUpdate({ taskId, status: "completed" })`.

    #### Phase 0 — Frame Gate (always)

    Self-review before spawning reviewers. Verify all hold, fix plan if not:
    - [ ] Plan addresses the core requirement
    - [ ] No fundamental constraints violated
    - [ ] Approach viable given actual codebase structure
    - [ ] Preplan Success Criteria satisfied (if they exist)

    #### Review Phases

    | Phase | Condition | Provider | Round Label |
    |-------|-----------|----------|-------------|
    | 1 | `--codex` only | `"codex"` | `(Codex)` |
    | 2 | always | `"claude"` | `(Claude)` |

    For each applicable phase, repeat (max 5 rounds):

    **4a. Workflow Dispatch**

    ```
    workflow({
      expression: "(architect, critic)" + (if --deep: " -> resolver"),
      context: (if --deep: "--deep\n\n") + "Review plan: {plan file path}\nWorking directory: {work_dir}\n{context, preplan constraints}\nSuccess Criteria (must be satisfied):\n{preplan Success Criteria items}",
      init_prompt: "Review the plan.",
      provider: "{phase provider}"
    })
    ```
    - **If `--deep`**: `wait({ jobs: [job], inline: false })` →
      `{ start, end } = result.workflow.steps.find(s => s.agent === "resolver")` → `Read(result.content, start, end - start + 1)`.
    - **Otherwise**: `wait({ jobs: [job], inline: true })` → read `result.content`.

    **4b. Post-Round Processing**

    **If `--deep`**: Resolver has already applied Adopt/Adapt changes to the plan file.
    Read the updated plan file, then the resolver's synthesis report from the workflow result.
    Record Deferred/Diverged items.

    **Otherwise**: `result.content` is `<architect>…</architect>` + `<critic>…</critic>`.
    Read `CORAL_METHODS/HOW-SYNTHESIZE.md` and resolve the findings yourself. Edit the plan file.

    **4c. Round Summary** (AFTER 4b)

      ## Round N ({Round Label})

      | # | Source | Finding | Severity | Level | Classification |
      |---|--------|---------|----------|-------|----------------|
      | 1 | Critic #1/#4 | Description | HIGH | FRAME | Adopt |
      | 2 | Both | Description | MEDIUM | — | Adapt |

      - Deduplicate overlapping findings (use "Both" as source)
      - Order by Severity (CRITICAL > HIGH > MEDIUM > LOW)

      **Changes Applied**: [what was edited]

    **4d. Exit Condition**
    **If `--deep`**: Read `CORAL_METHODS/HOW-COMPLETE.md` and apply its additional completion criteria alongside the rules below.
    Evaluate based on what reviewers RETURNED this round (not your post-edit assessment):
    - **Continue**: Either reviewer returned CRITICAL or HIGH → go to 4a for re-verification.
    - **Fix and pass**: No CRITICAL/HIGH but MEDIUM/LOW exist → fixes applied, exit.
    - **Clean pass**: No findings above LOW (and HOW-COMPLETE satisfied, if `--deep`) → proceed to next phase (or step 5 if last phase).
    - **Max rounds (5)**: Proceed to next phase (or `AskUserQuestion` — continue, finalize, or abort — if last phase).

    ### 5. Completion
    Delete all Phase Tasks created in step 4.
    Return: plan file path + final summary (see `<Output_Format>`).
  </Protocol>
  <Error_Handling>
    | Scenario | Action |
    |----------|--------|
    | Workflow job fails | Retry once. If still fails and more phases remain, skip to next phase. Otherwise AskUserQuestion. |
    | Resolver fails (`--deep`) | Retry once. If still fails, AskUserQuestion. |
  </Error_Handling>
  <Constraints>
    | DO | DON'T |
    |----|-------|
    | Create stub plan file first | Use EnterPlanMode (`~/.claude/plans/`) |
    | Use workflow for all review phases | Run reviewers sequentially |
    | Synthesize with HOW-SYNTHESIZE (no `--deep`) or resolver (`--deep`) | Spawn resolver without `--deep` |
    | Cite file:line in plans | Write vague plans without references |
    | Exit when no CRITICAL/HIGH | Continue reviewing past convergence |
    | Return plan file path | Implement within this protocol |
  </Constraints>
  <Output_Format>
    ## Planning Complete

    **Plan file**: `.claude/coral/plans/{topic}.md`

    ### Review Summary
    - Phases: [0 (Frame Gate) + 1 (Codex) + 2 (Claude)] or [0 (Frame Gate) + 1 (Claude)]
    - Rounds: N per phase
    - Final verdict: [APPROVED / APPROVED WITH CONDITIONS]
    - Key changes from review: [brief list]
    - ⚠️ **Unsatisfied Success Criteria**: [list with reasons] *(omit if all satisfied)*

    ### Final Plan
    Summarize the plan file for the user — include all decisions, constraints,
    and action items the user needs to know, but omit verbose details they can
    look up in `.claude/coral/plans/{topic}.md` if needed.

    ### Implementation Handoff

    **If `--no-handoff`**: stop after showing the summary above. The caller controls the next step.

    **Otherwise**, ask the user how to implement.
    ```
    AskUserQuestion({
      question: "How would you like to implement?",
      options: ["coral:ralph", "coral:ralph --codex", "coral:ralph --red --codex", "Skip"]
    })
    ```
    If not skipped: `Skill({ skill: "coral:ralph", args: "[selected flags] <plan summary + context>" })`
  </Output_Format>
</Planning_Protocol>
