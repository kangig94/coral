---
name: ralph
description: Persistent execution loop with verification (sonnet) - best for implementing an existing plan
argument-hint: "[--red] [task description]"
model: sonnet
---

```!
mkdir -p "$CLAUDE_PROJECT_DIR/.claude/coral/tmp" && touch "$CLAUDE_PROJECT_DIR/.claude/coral/tmp/kb-active"
```

# Persistent Execution with Verification

Announce at start: "Using ralph to execute this task with verification loop."

## Execution

1. **Load protocol**: Read `agents/ralph.md` to load the full ralph protocol
2. **Apply the Iron Law**: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
3. **Execute the task**: Follow the protocol's `<Investigation_Protocol>` steps (loops until all acceptance criteria pass)
4. **Verification Gate**: Before any completion claim:
   - IDENTIFY what command proves the claim
   - RUN the command (fresh, complete)
   - READ the output, check exit code
   - VERIFY the output confirms the claim
   - ONLY THEN make the claim
5. **Post-implementation sequence** (strict order, fail-fast by cost):
   **Scope gate**: Steps a-d apply only when source-affecting files are modified (`src/`, `scripts/`, `package.json`, `tsconfig.json`). Non-source changes (`agents/`, `skills/`, `docs/`, `hooks/`, `.claude/`) skip directly to completion.

   **`--red` adversarial testing**: If `--red` is present in the task argument, spawn `coral:red-attacker` via Task tool in **background** (`run_in_background: true`) immediately before step a. Include in the prompt:
   - `implementer: claude`
   - Changed files list or scope description
   - `plan_context: <plan summary>` (if a plan was used for this task)

   a. **Lint**: Run linter if available. Cheapest check first.
   b. **Parallel validation**: Spawn `coral:architect` for architecture review. Additionally, if project instructions define workflow rules (e.g., review-orchestrator), execute them as parallel subagents alongside architect. Both must pass before proceeding to build.
   c. **Build**: Run the project's build command.
   d. **Red-attacker gate** (if `--red`): Wait for background red-attacker to complete. Read its output for the list of generated test files.
   e. **Test**: Run the test suite after build succeeds. If `--red`, this now includes adversarial tests.
   f. **Red fix loop** (if `--red` and adversarial test failures): Fix failures → re-run test. Cap at **3 iterations** - if still failing, report remaining failures and escalate rather than looping indefinitely.
   g. **Red triage** (if `--red` and tests pass): Review each red test before merging. Red-attacker runs without full context - it may generate tests that target the wrong module, duplicate existing coverage, or test unreachable scenarios.
      - For each `red-<target>.<ext>` file, read the test and verify:
        * Tests target code that was actually changed in this task (not unrelated modules)
        * Test scenarios are reachable (not testing impossible states or mocked-away paths)
        * No substantial overlap with existing tests in the main test file
      - **Merge** tests that pass triage: move `describe` blocks into the main test file (append at end, preserve imports), delete the `red-` file
      - **Discard** tests that fail triage: delete the `red-` file, note the reason briefly
      - Re-run tests to verify merge correctness
      - Record the adversarial test provenance in the commit message, not in file naming

## Context Enhancement

From the current conversation, identify and include:
- Task description and acceptance criteria
- File paths and code sections relevant to the work
- Current progress and any prior verification results
- Constraints or preferences stated by the user

## Error Policy

If `agents/ralph.md` cannot be read, report the error to the user. Do not fall back to inline execution - the agent protocol is a required dependency.
