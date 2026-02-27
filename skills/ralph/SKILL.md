---
name: ralph
description: Persistent execution loop with verification (sonnet) - best for implementing an existing plan
argument-hint: "[--red] [--codex] [task description]"
model: sonnet
---

```!
mkdir -p "$CLAUDE_PROJECT_DIR/.claude/coral/tmp" && touch "$CLAUDE_PROJECT_DIR/.claude/coral/tmp/kb-active"
```

# Persistent Execution with Verification

Announce at start: "Using ralph to execute this task with verification loop."

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |

Strip the `--codex` flag before passing the prompt to the execution path.

## Execution

1. **Load protocol**:
   - **Default**: Read `PROTOCOL.md` (in this skill directory) to load the full ralph protocol
   - **`--codex`**: Read `agents/codex-proxy.md` for the prompt template and system instructions. Use the ralph role's prompt template (`### Role: ralph` section). **You** call Codex directly - do NOT spawn a codex-proxy agent.

2. **Execute task**:
   - **Default**: Apply the Iron Law: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE. Follow the protocol's `<Investigation_Protocol>` steps (loops until all acceptance criteria pass). Before any completion claim: IDENTIFY what command proves the claim → RUN the command → READ the output → VERIFY → ONLY THEN claim.
   - **`--codex`**: Execution loop:
     a. **Call Codex**: Use `codex({ op: "exec", ... })` (first round) or `codex({ op: "exec", session: <thread_id>, ... })` with saved thread_id (subsequent rounds). Follow the protocol's prompt template. Pass `working_directory` and `reasoning_effort: "high"`.
     b. **Save thread_id** from the response for session continuity
     c. **Verify** the changes yourself: read changed files, compare against acceptance criteria. Use LSP/type-check only. NEVER run build or test during the execution loop.
     d. **Loop decision**: All criteria pass → exit loop, go to Post-Completion Review. Not complete → go to step a with thread_id + updated progress context. Max 5 rounds → ask user whether to continue or finalize.

3. **Post-Completion Review** (`--codex` only):
   **Tests passing does not mean the work is correct.** Codex may produce code that passes tests but diverges from the plan - especially for untestable content (docs, prompts, config).
   a. **Read every changed file** that Codex modified across all rounds
   b. **Compare against the plan/requirements** - does each file match what was specified?
   c. **Flag untestable content** - documentation, markdown, config: verify these match the plan
   d. **Fix discrepancies yourself** - do not send back to Codex; fix them directly
   e. **Report to the user** what was done correctly and what you corrected

4. **Post-implementation sequence** (strict order, fail-fast by cost):
   **Scope gate**: Steps a-d apply only when source-affecting files are modified (`src/`, `scripts/`, `package.json`, `tsconfig.json`). Non-source changes (`agents/`, `skills/`, `docs/`, `hooks/`, `.claude/`) skip directly to completion.

   **`--red` adversarial testing**: If `--red` is present in the task argument, spawn `coral:red-attacker` via Task tool in **background** (`run_in_background: true`) immediately before step a. Include in the prompt:
   - `implementer: claude` (default) or `implementer: codex` (`--codex`)
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

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode. Otherwise, omit the field.

## Context Enhancement

From the current conversation, identify and include:
- Task description and acceptance criteria
- File paths and code sections relevant to the work
- Current progress and any prior verification results
- Constraints or preferences stated by the user

## Error Policy

If `PROTOCOL.md` (default) or `agents/codex-proxy.md` (`--codex`) cannot be read, report the error to the user. Do not fall back to inline execution - the agent protocol is a required dependency.
