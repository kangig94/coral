---
name: plan
description: 'Use when a task needs structured planning before implementation. Supports --deep and --codex flags.'
argument-hint: '[--deep] [--codex] [task description]'
---

# Planning

Execute a multi-round planning session with architect/critic review.

## Argument Routing

| Argument       | Mode                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `<prompt>`     | Claude-native (default)                                                                            |
| `--codex`      | Codex delegation (context from conversation)                                                       |
| `--deep`       | Methodology-driven: spawn resolver (HOW-SYNTHESIZE), read HOW-COMPLETE, pass `--deep` to reviewers |
| `--no-handoff` | Internal: skip implementation prompt at step 5 (caller controls next step)                         |

Strip `--codex`, `--deep`, and `--no-handoff` flags before passing the prompt to the execution path.

<Planning_Protocol>
<Role>
You are the **Orchestrator**: write plans, dispatch reviewer workflows, synthesize feedback (or delegate to resolver in `--deep`), iterate until approval.
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
    Phase 1 runs only when `--codex` flag is set. Phase 2 always runs (unless skipped by Complexity Gate).

    **Task registration**: Before starting Phase 0, register one Task per applicable phase:
    - `TaskCreate({ subject: "Phase 0 — Frame Gate" })`
    - `TaskCreate({ subject: "Phase 1 — Codex review" })` (only if `--codex`)
    - `TaskCreate({ subject: "Phase 2 — Claude review" })`
    - `TaskCreate({ subject: "Execution Ordering" })`

    On phase start: `TaskUpdate({ taskId, status: "in_progress" })`.
    On each round: `TaskUpdate({ taskId, subject: "Phase N — {label} (round M/5)" })`.
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
    - Total implementation ≤ ~30 lines changed across all files
    - No new files created
    - No public API or interface changes
    - No new abstractions, patterns, or architectural decisions
    - Each change is a localized fix (not cross-cutting)
    - Root cause and fix are already confirmed (e.g., from debugger, preplan, or prior analysis)

    If ALL criteria pass:
    ```
    AskUserQuestion({ questions: [
      { question: "Plan is low-complexity (N lines, M files, localized fixes). Skip review?", header: "Review",
        options: [
          { label: "Skip review", description: "Proceed directly to implementation" },
          { label: "Review anyway", description: "Run full review loop" }
        ], multiSelect: false }
    ]})
    ```
    If "Skip review" → skip to step 4e (Execution Order), then step 5 (Completion).
    If "Review anyway" → proceed to Review Phases normally.

    If ANY criterion fails → proceed to Review Phases (no prompt).

    #### Review Phases

    | Phase | Condition | Provider | Round Label |
    |-------|-----------|----------|-------------|
    | 1 | `--codex` only | `"codex"` | `(Codex)` |
    | 2 | always | `"claude"` | `(Claude)` |

    For each applicable phase, repeat (max 5 rounds):

    **4a. Workflow Dispatch**

    ```
    expression = "(coral:architect, coral:critic)" or "(coral:architect, coral:critic) -> coral:resolver" when --deep
    startPrompt = "Success Criteria (must be satisfied):\n{preplan Success Criteria items}\n\n{round context, key changes from previous rounds, key files to check, preplan constraints}"
    sharedContext = (if --deep: "--deep\n\n") + "Review plan: {plan file path}\n\nDo not promote KB notes."
    launch = Bash(`coral-cli workflow -e "${expression}" -s "${startPrompt}" -c "${sharedContext}" -p "{phase provider}" -w "{work_dir}" -d --output-format json`)
    ```
    - **If `--deep`**: `coral-cli wait --jobs "<job>" --output-format json` →
      read the terminal JSON line, then `{ start, end } = event.result.workflow.steps.find(s => s.agent === "resolver")` → `Read(event.result.path, start, end - start + 1)`.
    - **Otherwise**: `coral-cli wait --jobs "<job>" --output-format json --embed` → use `event.result.content ?? Read(event.result.path)`.

    **4b. Post-Round Processing**

    **If `--deep`**: Resolver has already applied Adopt/Adapt changes to the plan file.
    Read the updated plan file, then the resolver's synthesis report from the workflow result.
    Record Deferred/Diverged items.
    ⛔ The resolver applying changes does NOT mean the phase can exit — you MUST still write the Round Summary (4c) and evaluate the Exit Condition (4d). Do not skip to the next phase.
    ⛔ **Prior-agreement guard**: After reading the resolver's changes, verify that no prior agreement with the user was overridden. Reviewers and resolvers lack conversation context — they may reject or restructure decisions the user already confirmed. If the resolver changed an explicitly agreed-upon design decision, revert that change in the plan and note it as a rejected finding. The user's explicit decisions take precedence over reviewer recommendations.

    **Otherwise**: the terminal JSON line from `coral-cli wait` yields `<architect>…</architect>` + `<critic>…</critic>` in `event.result.content`; if it is absent, read `event.result.path`.
    Read `CORAL_METHODS/HOW-SYNTHESIZE.md` and resolve the findings yourself. Edit the plan file.
    If findings invalidate the current approach, propose an alternative path that achieves the user's goal. If no viable alternative exists, state why and continue to the next round.

    **4c. Round Summary** (AFTER 4b)

    Output the following to the user as conversation text. Do NOT write it to the plan file.

      ## Round N ({Round Label})

      | # | Source | Finding | Severity | Level | Classification |
      |---|--------|---------|----------|-------|----------------|
      | 1 | Critic #1/#4 | Description | HIGH | FRAME | Adopt |
      | 2 | Both | Description | MEDIUM | — | Adapt |

      - **If `--deep`**: extract from the resolver's Classification Table. Source = Reviewer name. Do NOT summarize, paraphrase, or omit columns — the user needs the full table to audit the review.
      - **Otherwise**: produce yourself after synthesis.
      - Deduplicate overlapping findings (use "Both" as source)
      - Order by Severity (CRITICAL > HIGH > MEDIUM > LOW)

      **Changes Applied**: [what was edited, with rationale for each change]

      **Continue Decision** (`--deep`): **{Verdict}** — {Rationale} (from resolver)
      **Continue Decision** (non-deep): **{Continue|Exit}** — Round {N}, highest severity = {X}. Rule: {cite exit condition rule that applies}.

    **4d. Exit Condition**

    **Step 1 — Completion assessment** (`--deep` only):
    If `--deep`: Read `CORAL_METHODS/HOW-COMPLETE.md`. Evaluate coverage gaps (Counterexample Coverage),
    effort quality (Refutation Effort), and convergence pattern (Progressive Focus).
    Record the assessment — it informs both the verdict (Step 2) and next-round steering (Continue path).

    **Step 2 — Verdict**:

    **If `--deep`**: You MUST follow the resolver's **Continue Decision** verdict — do not override or reinterpret it. Continue → 4a (or next phase at round 5). Exit → fix remaining MEDIUM/LOW inline, then Step 3. Hard override: CRITICAL findings always Continue. If Continue Decision is missing, fall back to the non-deep severity gate below.

    **Otherwise**: Follow the **Continue Decision** written in 4c. The decision MUST match the severity gate: CRITICAL/HIGH at round < 5 → Continue (4a). CRITICAL/HIGH at round 5 → next phase. MEDIUM → fix inline, then Step 3. LOW/none → Step 3. Severity is never reclassified at exit — only during synthesis (4b). If the Continue Decision in 4c is missing or inconsistent with the severity gate, treat it as a protocol violation and re-evaluate.

    **Step 3 — Completion gate** (`--deep` only, otherwise exit phase):

    Apply ALL conditions in HOW-COMPLETE's Combined Exit Rule using the Step 1 assessment.
    If any condition fails → **Continue** (→ 4a, next round).
    Exit phase only when both Step 2 AND Step 3 pass.

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
    | Resolver fails (`--deep`) | Retry once. If still fails, AskUserQuestion. |
  </Error_Handling>
  <Constraints>
    | DO | DON'T |
    |----|-------|
    | Create stub plan file first | Use EnterPlanMode (`~/.claude/plans/`) |
    | Use workflow for all review phases | Run reviewers sequentially |
    | Synthesize with HOW-SYNTHESIZE (no `--deep`) or resolver (`--deep`) | Spawn resolver without `--deep` |
    | Cite file:line in plans | Write vague plans without references |
    | Exit when resolver says Exit or no CRITICAL/HIGH (non-deep) | Continue reviewing past convergence |
    | Return plan file path | Implement within this protocol |
  </Constraints>
  <Output_Format>
    ## Planning Complete

    **Plan file**: `CORAL_PROJECT/plans/{topic}.md`

    ### Review Summary
    - Phases: [0 (Frame Gate) + 1 (Codex) + 2 (Claude)] or [0 (Frame Gate) + 1 (Claude)]
    - Rounds: N per phase
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
          { label: "ralph --codex", description: "Codex delegation" },
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
