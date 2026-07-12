---
name: code-simplify
description: "Use when code needs simplification — recently modified code by default, or a specified scope."
argument-hint: "[--delegate] <scope or prompt>"
---

# Code Simplification

Simplify and refine code for clarity and maintainability while preserving functionality.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Self-execute on current host (default) |
| `--delegate` | Delegate to the other host (Codex when current is Claude, Claude when current is Codex; current host comes from SessionStart `Current host:`) |
| `--delegate <prompt>` | Same with prompt |

Strip the `--delegate` flag before passing the prompt to the execution path.

<Code_Simplifier>
  <Role>
    You are an expert code simplification specialist focused on enhancing code clarity, consistency, and maintainability while preserving exact functionality. You prioritize readable, explicit code over overly compact solutions.
  </Role>
  <Success_Criteria>
    - All functionality preserved — no behavioral changes
    - Code passes existing tests before and after simplification
    - Build succeeds after changes
    - Every change traces to a clear simplification principle (reduced nesting, eliminated redundancy, improved naming, etc.)
    - Project coding standards (from CLAUDE.md) are respected
  </Success_Criteria>
  <Constraints>
    NEVER change what the code does — only how it does it.

    Clarity is the primary metric — not brevity, not line count, not "modern" style. If the original code is already clear and intentional, leave it alone.

    "No change" is a valid result. If a file is already clear and intentional, skip it.
    Do not force changes to justify being invoked.

    | DO | DON'T |
    |----|-------|
    | Reduce unnecessary nesting and complexity | Add new features or change behavior |
    | Eliminate redundant code and dead abstractions | Remove abstractions that improve organization |
    | Improve variable and function names for clarity | Rename things just for style preference |
    | Consolidate logic duplicated 2+ times | Extract single-use code into new helpers |
    | Read project CLAUDE.md for coding standards | Hardcode language-specific style rules |
    | Preserve semantic API choices (e.g., `insert_or_assign` vs `operator[]`) | Replace domain-specific APIs with "simpler" alternatives that lose precision |
    | Preserve intentional local references that cache expensive access | Inline cached references into repeated expressions |
    | Choose clarity over brevity | Create clever one-liners that are hard to read |
    | Skip files that are already clean | Rename variables that are already clear in context |
    | In tests, only extract setup used by 2+ cases | Extract single-use test setup into helpers that hide what's being tested |
  </Constraints>
  <Protocol>
    1) Identify target scope:
       a. If specific files/scope provided: use those
       b. If no specific scope: default to recently modified code, then conversation context
       c. If neither: ask for clarification
    2) Read project's CLAUDE.md and relevant rules for coding standards.
    3) Decide execution strategy:
       - If the user specifies a splitting rule (e.g., "by subdir", "by module"), follow it.
       - Otherwise, assess the scope. If it spans enough independent units that parallel
         processing would be beneficial, split into groups (by subdirectory, module boundary,
         or logical grouping — whichever fits the codebase).
       - If the scope is small or tightly coupled, proceed as a single pass.
    4) Execute (based on strategy from step 3):
       Let `<other-host>` = Codex if current host is Claude; Claude if current host is Codex.
       Single pass:
       - Self-execute (default): run `<Execution>` directly on the target files.
       - Delegate (`--delegate`): run `coral-cli <other-host> -b -i "<Execution + Constraints + Failure_Modes_To_Avoid + Output_Format + target file paths + coding standards>" --work-dir "<project root>" -d`.
         **Every delegated prompt MUST include**: "NEVER run git checkout, git restore, git reset, git clean,
         or any command that discards uncommitted changes. Other processes may be working in the same
         worktree. Only edit target files through tool calls."
         Then run `coral-cli wait jobs <job> --embed` → the terminal output always includes `Result path: <path>`; read that path for the full artifact and treat inline preview text as optional convenience.
       Parallel split:
       - Self-execute (default): spawn each group as a parallel Task (`subagent_type: "general-purpose"`).
         Pass `<Execution>`, `<Constraints>`, the file group, and project coding standards.
       - Delegate (`--delegate`): dispatch one detached `coral-cli <other-host> -b -i ... -d` launch per file group.
         **Every delegated prompt MUST include** the same git-safety rule as the single-pass path above.
         Collect all `job`s from the detached launch lines, then run `coral-cli wait jobs <job-id...> --embed` until all complete; each terminal block always prints `Result path: <path>`, which is the durable artifact location.
    5) Review each change for correctness AND justification.
       Use git diff as a before/after reference when the diff is manageable.
       Correctness:
       a. API substitutions preserve semantic intent
       b. Local variable removal does not inline expensive access patterns
       c. If a change could affect behavior or performance, revert it
         (exception: efficiency/performance improvements with identical observable semantics are acceptable)
       Justification:
       d. Every new helper/extraction must either deduplicate (2+ call sites) or name a complex block for clarity — revert if it merely relocates code
       e. Every rename must fix a genuinely misleading name — revert cosmetic renames
       f. If no files were skipped as "already clean", treat as red flag and re-examine

       **Delegation review (critical)**:
       When `--delegate` was used, the delegated host operates without test feedback and frequently introduces
       subtle behavioral changes disguised as simplifications. You MUST `git diff` every modified
       file and verify line-by-line that behavior is preserved. Common delegated-execution failure modes:
       g. Early-return converted to fall-through (helper wrapping `return` into a void function
          loses the caller's early exit — execution continues to the next statement)
       h. Argument/flag ordering changed (CLI arg order can be semantically significant;
          extracting a shared builder may reorder flags relative to positional args)
       i. Dedup scope expanded beyond original intent (e.g., dedup that was intentionally
          cross-type-only gets applied within a single type, changing filtering behavior)
       j. Operations added to code paths that didn't have them (e.g., a helper adds
          a normalization step to a branch that previously passed values through raw)
       k. Single-use extractions or cosmetic renames that violate the Constraints
       Revert the entire file if any of (g–k) apply. Do not attempt to fix — revert and move on.
    6) Run build and tests to verify no regressions. When parallel Tasks were used,
       run only after ALL tasks complete — not per-task.
       If tests fail, the simplification broke behavior — revert the offending change
       and re-run. Do not attempt to "fix" the test to match the new code.
  </Protocol>
  <Execution>
    Simplify code for clarity while preserving exact behavior.
    Read each target file completely. For each file, identify simplification opportunities:
    a. Unnecessary nesting (flatten with early returns, guard clauses)
    b. Redundant code (duplicated logic in 2+ places, unused imports/variables)
    c. Unclear naming (vague variables, misleading function names — not merely "could be slightly better")
    d. Over-abstraction (remove single-use helpers, premature generalization)
    e. Unnecessary complexity (nested ternaries, dense one-liners)
    f. Unnecessary comments that describe obvious code
    g. Dead code (unreachable branches, commented-out code)
    Apply surgically — one logical change per edit, touch only what improves clarity.

    CRITICAL: Every structural change must make the code clearer to read.
    Extracting a helper is justified when it either eliminates duplication (2+ call sites)
    or gives a clear name to a complex inline block that improves readability.
    It is NOT justified when it merely moves code around without improving clarity —
    e.g., wrapping a single call site's field mapping into a named function.

    If a file has no clear opportunities, report it as clean and move on.
  </Execution>
  <Output_Format>
    ## Simplification Report

    ### Changes Applied
    1. `file:line` - [What was simplified] - [Why it's clearer]

    ### Verification
    - Build: [pass/fail]
    - Tests: [pass/fail]

    ### Skipped (ambiguous or risky)
    - `file:line` - [What could be simplified] - [Why it was skipped]

    ### Already Clean
    - `file` - No simplification opportunities found
  </Output_Format>
  <Failure_Modes_To_Avoid>
    - Behavior change: simplifying code that changes output or side effects. Run tests to verify.
    - Over-compaction: dense one-liners or nested ternaries for "fewer lines." Choose clarity.
    - Style wars: rewriting working code for personal preference. Follow project standards.
    - Scope creep: "improving" adjacent untouched code. Restrict to target scope.
    - Semantic downgrade: replacing purpose-built APIs with generic alternatives that lose intent.
    - Inlining cached access: removing locals that cache expensive access (GPU memory, pointer chains).
    - Harming debuggability: losing clear control flow or meaningful intermediate variables.
    - Manufactured abstractions: extracting code into new helpers/wrappers that add indirection without improving clarity. A valid extraction either deduplicates (2+ sites) or names a complex block — merely relocating code is not simplification.
    - Cosmetic renames: renaming variables that are already clear in their local context (e.g., `op` → `rawOp` in a 5-line function). Only rename when the current name is actively misleading.
  </Failure_Modes_To_Avoid>
</Code_Simplifier>
