---
name: plan
description: 'Use when a task needs structured planning before implementation. Supports --delegate and round=N[,M].'
argument-hint: '[--delegate] [round=N[,M]] [task description]'
---

# Planning

Execute a multi-round planning session with architect/critic review.

## Argument Routing

| Argument       | Mode                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `<prompt>`     | Self-execute on current host (default)                                                             |
| `--delegate`   | Add review pass on the other host (Claude → Codex, Codex → Claude, Copilot → Codex; from SessionStart `Current host:`) |
| `round=N`      | Review rounds for every applicable phase (default `1`). e.g. `round=3` for deeper iteration. |
| `round=N,M`    | Per-phase budget: Phase 1 (`<other-host>`) gets `N` rounds, Phase 2 (`<current-host>`) gets `M`. **Turns `--delegate` on.** |
| `--no-handoff` | Internal: skip implementation prompt at step 5 (caller controls next step)                         |

Reviewers and the resolver always run — the round budget only sets how many times each phase iterates.

**Parsing the round budget** (`round=…` and `--round=…` are the same token):

- `round=N` → every applicable phase gets `N`. Does not affect `--delegate`.
- `round=N,M` → `{maxRounds[1]}` = `N`, `{maxRounds[2]}` = `M`, and `--delegate` is on whether or not it was written. Phase 1 exists only under `--delegate`, so naming two budgets IS the request for both phases.
- Absent → `1` for every phase.
- Every value must be an integer ≥ 1. More than two values, a `0`, or a non-integer is a usage error: report it and stop. Do not clamp, drop the extras, or fall back to the default.

Strip `--delegate`, the round token, and `--no-handoff` before passing the prompt to the execution path.

<Planning_Protocol>
<Role>
You are the **Orchestrator**: write plans, dispatch reviewer workflows, delegate synthesis to the resolver, iterate until approval or the round budget is reached.
Treat reviewer feedback as collaborative input — engage with substance, not verdict.
Planning only — no source code, no EnterPlanMode, no implementation.
</Role>
<Protocol> ### 1. Create Plan File
If invoked from preplan, `{topic}` is already defined. Otherwise, derive `{topic}` from the user's input as English kebab-case.
Write a stub plan file to `CORAL_PROJECT/plans/{topic}.md` **immediately** — before any research.
Do NOT use EnterPlanMode — it writes to `~/.claude/plans/` which is not project-local.

    Stub structure (empty sections) — copy headings verbatim including parenthetical annotations:
      # [Plan Title]
      **Preplan**: `CORAL_PROJECT/plans/pre-{topic}.md` (omit if no preplan exists)
      ## Requirements Summary
      ## Acceptance Criteria (testable, verifiable — register each as a Task during implementation)
      ## Execution Order (dependency graph, batches, file mapping — written after review loop, see step 4e)
      ## Mathematical Specification (if applicable)
      ## Implementation Phases (with file:line references)
      ## Risks & Mitigations
      ## Verification Steps

    The plan file is the single source of truth. All subsequent work edits this file directly.

    ### 2. Gather Context
    Parse task description, read key files, identify acceptance criteria, extract working directory.
    - **Preplan**: If `CORAL_PROJECT/plans/pre-{topic}.md` exists, read it.
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

    Phase 0 always runs first. Phase 0b (Complexity Gate) may skip review phases.
    Phase 1 runs only when `--delegate` is set — explicitly, or implied by a two-value `round=N,M` (review on the other host). Phase 2 always runs (unless skipped by Complexity Gate; review on the current host).

    **Round budget**: `{maxRounds[P]}` is phase P's own budget. `round=N` gives every phase `N`; `round=N,M` gives Phase 1 `N` and Phase 2 `M`; absent gives every phase `1`. Each phase iterates up to its own budget and then exits — a phase at budget `1` runs exactly one round with no iteration. Phase structure is independent of the budget: Phase 1 (if `--delegate`) and Phase 2 still run whatever the numbers are.

    **Task registration**: Before starting Phase 0, register one Task per applicable phase:
    - `TaskCreate({ subject: "Phase 0 — Frame Gate" })`
    - `TaskCreate({ subject: "Phase 1 — <other-host> review" })` (only if `--delegate`, explicit or implied)
    - `TaskCreate({ subject: "Phase 2 — <current-host> review" })`
    - `TaskCreate({ subject: "Execution Ordering" })`

    On phase start: `TaskUpdate({ taskId, status: "in_progress" })`.
    On each round: `TaskUpdate({ taskId, subject: "Phase P — {label} (round M/{maxRounds[P]})" })`.
    On phase complete: `TaskUpdate({ taskId, status: "completed" })`.

    #### Phase 0 — Frame Gate (always)

    Self-review before spawning reviewers. Verify all hold, fix plan if not:
    - [ ] Plan addresses the core requirement
    - [ ] No fundamental constraints violated
    - [ ] Approach viable given actual codebase structure
    - [ ] Preplan Success Criteria satisfied (if they exist)

    #### Phase 0b — Complexity Gate (after Frame Gate passes)

    Evaluate whether the plan warrants full review. ALL of the following must hold
    to qualify as low-complexity:
    - At most 1 new file created
    - No public API or interface changes
    - No new abstractions, patterns, or architectural decisions
    - Each change is a localized fix (not cross-cutting)
    - Root cause and fix are already confirmed (e.g., from debugger, preplan, or prior analysis)
    - No apparent domain-specific risk (concurrency, persistence atomicity, state machine transitions, recovery paths, security-sensitive edits)

    If ALL criteria pass → print a one-line gate decision to conversation output and
    skip directly to step 4e (Execution Order), then step 5 (Completion):

    ```
    Complexity gate passed: {M} files, {localized fix summary} — skipping review.
    ```

    If ANY criterion fails → proceed to Review Phases.

    #### Review Phases

    Let `<current-host>` come from SessionStart `Current host:`. Let `<other-host>` = the other of `codex`/`claude` — and `codex` when `<current-host>` is `copilot`, which is a plugin host but not a delegation target.

    | Phase | Condition | Provider | Round Label | Budget |
    |-------|-----------|----------|-------------|--------|
    | 1 | `--delegate`, explicit or implied by `round=N,M` | `<other-host>` | `(<other-host capitalized>)` | `{maxRounds[1]}` |
    | 2 | always | `<current-host>` | `(<current-host capitalized>)` | `{maxRounds[2]}` |

    Run the phases in order. For each applicable phase, repeat up to that phase's own `{maxRounds[P]}` rounds (default 1):

    **4a. Workflow Dispatch**

    ```
    expression = "(coral:architect, coral:critic) -> coral:resolver"
    startPrompt = "Success Criteria (must be satisfied):\n{preplan Success Criteria items}\n\n{round context, key changes from previous rounds, key files to check, preplan constraints}"
    sharedContext = "--deep\n\nReview plan: {plan file path}\n\nDo not promote KB notes."
    launch = Bash(`coral-cli workflow -e "${expression}" -s "${startPrompt}" -c "${sharedContext}" -p "{phase provider}" -w "{work_dir}" -d`)
    ```
    Reviewers always run in `--deep` methodology and the resolver always runs — both are independent of the round budget.
    `coral-cli wait jobs <job>` → the terminal output prints `Result path: <path>`; read that artifact for the full workflow result and locate the resolver's synthesis section there.

    **4b. Post-Round Processing**

    The resolver has already applied Adopt/Adapt changes to the plan file.
    Read the updated plan file, then the resolver's synthesis report from the workflow result.
    Record Deferred/Diverged items.
    ⛔ The resolver applying changes does NOT mean the phase can exit — you MUST still write the Round Summary (4c) and evaluate the Exit Condition (4d). Do not skip to the next phase.
    ⛔ **Prior-agreement guard**: After reading the resolver's changes, verify that no prior agreement with the user was overridden. Reviewers and resolvers lack conversation context — they may reject or restructure decisions the user already confirmed. If the resolver changed an explicitly agreed-upon design decision, revert that change in the plan and note it as a rejected finding. The user's explicit decisions take precedence over reviewer recommendations.
    If the resolver's findings invalidate the current approach without redirecting it, propose an alternative path that achieves the user's goal. If no viable alternative exists, state why and continue to the next round (or exit if at the round cap).

    **4c. Round Summary** (AFTER 4b)

    Output the following to the user as conversation text. Do NOT write it to the plan file.

      ## Round N ({Round Label})

      | # | Source | Finding | Severity | Level | Classification |
      |---|--------|---------|----------|-------|----------------|
      | 1 | Critic #1/#4 | Description | HIGH | FRAME | Adopt |
      | 2 | Both | Description | MEDIUM | — | Adapt |

      - Extract from the resolver's Classification Table. Source = Reviewer name. Do NOT summarize, paraphrase, or omit columns — the user needs the full table to audit the review.
      - Deduplicate overlapping findings (use "Both" as source)
      - Order by Severity (CRITICAL > HIGH > MEDIUM > LOW)

      **Changes Applied**: [what was edited, with rationale for each change]

      **Continue Decision**: **{Verdict}** — {Rationale} (from resolver). At round `{maxRounds[P]}` the phase exits regardless of the verdict — note the round cap when it forces the exit.

    **4d. Exit Condition**

    Follow the resolver's **Continue Decision** verdict — do not override or reinterpret it — but this phase's `{maxRounds[P]}` is the outer bound. A budget belongs to one phase: exhausting Phase 1 says nothing about Phase 2's.
    - **Round < `{maxRounds[P]}`**: Continue → 4a. Exit → fix remaining MEDIUM/LOW inline, then exit phase. Hard override: CRITICAL findings always Continue.
    - **Round == `{maxRounds[P]}`**: always proceed to the next phase (or Execution Order if this is the last phase), regardless of the verdict. Fix surviving MEDIUM inline; defer CRITICAL/HIGH to the next phase.

    A phase at budget `1` exits after its first round. Severity is never reclassified at exit — only during synthesis (4b). If the Continue Decision is missing, treat it as a protocol violation and re-evaluate from the resolver report's highest severity.

    ### 4e. Execution Order

    `TaskUpdate({ taskId: executionOrderingTaskId, status: "in_progress" })`
    After the review loop exits (Clean pass, Fix and pass, or Max rounds), write the **Execution Order** section in the plan file.

    **Step 1 — Dependency Analysis**: For each AC, identify:
    - **Files touched**: which files will be created or modified
    - **Logical dependencies**: does this AC require another AC's output? (e.g., API endpoint needs DB schema first)

    Build a dependency graph: AC_X depends on AC_Y if they modify the same file, or AC_X logically requires AC_Y's result.

    **Step 2 — Batch Grouping**: Topological sort the DAG into ordered batches:
    - **Batch 1**: all ACs with no dependencies (roots of DAG)
    - **Batch N**: ACs whose dependencies are all satisfied by prior batches
    - Within each batch, all ACs are independent and can execute in parallel.

    Write the result to the plan file:

    ```
    ## Execution Order

    ### Dependency Graph
    AC1 ─→ AC3
     │
     └──→ AC2 ─→ AC5
    AC4 (independent)

    ### Batches
    | Batch | ACs | Dependencies | Parallel |
    |-------|-----|--------------|----------|
    | 1 | AC1, AC4 | — | 2 |
    | 2 | AC2, AC3 | AC1 | 2 |
    | 3 | AC5 | AC2 | 1 |

    ### File Mapping
    | AC | Files |
    |----|-------|
    | AC1 | `src/schema.ts` |
    | AC2 | `src/api.ts`, `src/schema.ts` |
    | AC3 | `src/frontend/form.tsx` |
    | AC4 | `tests/unit.test.ts` |
    | AC5 | `docs/api.md` |
    ```

    Rules:
    - Every AC must appear in exactly one batch. No AC may be omitted.
    - ACs with no dependencies go in Batch 1.
    - File Mapping enables conflict detection — ACs in the same batch must NOT share files.
      If two independent ACs touch the same file, they must be sequenced (place one in a later batch).

    `TaskUpdate({ taskId: executionOrderingTaskId, status: "completed" })`

    ### 5. Completion
    Delete all Phase Tasks created in step 4.
    Return: plan file path + final summary (see `<Output_Format>`).

  </Protocol>
  <Error_Handling>
    | Scenario | Action |
    |----------|--------|
    | Workflow job fails | Retry once. If still fails and more phases remain, skip to next phase. Otherwise AskUserQuestion. |
    | Resolver fails | Retry once. If still fails, AskUserQuestion. |
  </Error_Handling>
  <Constraints>
    | DO | DON'T |
    |----|-------|
    | Create stub plan file first | Use EnterPlanMode (`~/.claude/plans/`) |
    | Use workflow for all review phases | Run reviewers sequentially |
    | Delegate synthesis to the resolver every round | Self-synthesize in the orchestrator or skip the resolver |
    | Cite file:line in plans | Write vague plans without references |
    | Exit when the resolver says Exit, or at that phase's `{maxRounds[P]}` | Continue past a phase's round budget, or spend one phase's budget on another |
    | Return plan file path | Implement within this protocol |
  </Constraints>
  <Output_Format>
    ## Planning Complete

    **Plan file**: `CORAL_PROJECT/plans/{topic}.md`

    ### Review Summary
    - Phases: [0 (Frame Gate) + 1 (<other-host>) + 2 (<current-host>)] or [0 (Frame Gate) + 2 (<current-host>)]
    - Rounds: rounds actually run / budget, per phase — e.g. `Phase 1: 2/3, Phase 2: 1/1`
    - Final verdict: [APPROVED / APPROVED WITH CONDITIONS]
    - Key changes from review: [brief list]
    - ⚠️ **Unsatisfied Success Criteria**: [list with reasons] *(omit if all satisfied)*

    ### Final Plan
    Summarize the plan file for the user — include all decisions, constraints,
    and action items the user needs to know, but omit verbose details they can
    look up in `CORAL_PROJECT/plans/{topic}.md` if needed.

    ### Implementation Handoff

    **If `--no-handoff`**: stop after showing the summary above. The caller controls the next step.

    **Otherwise**, ask the user how to implement:
    ```
    AskUserQuestion({ questions: [
      { question: "How would you like to implement?", header: "Mode",
        options: [
          { label: "ralph", description: "Claude-native sequential" },
          { label: "ralph --delegate", description: "Delegate to the other host" },
          { label: "ralph --team", description: "Parallel via Agent Teams" },
          { label: "Skip", description: "No implementation" }
        ], multiSelect: false },
      { question: "Enable adversarial testing?", header: "Red",
        options: [
          { label: "Skip (Recommended)", description: "No adversarial tests" },
          { label: "--red", description: "Spawn red-attacker (opposite model)" }
        ], multiSelect: false }
    ]})
    ```
    If not skipped: `Skill({ skill: "coral:ralph", args: "[selected flags] <plan summary + context>" })`

</Output_Format>
</Planning_Protocol>
