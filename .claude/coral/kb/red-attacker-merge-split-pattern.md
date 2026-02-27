# Red-Attacker Tests: Infrastructure Determines Destination File

## Rule
When merging red-attacker tests into their natural home files, let infrastructure requirements — not describe block grouping — determine where each test lands. A describe block that mixes pure unit assertions with session-store integration tests must be split across files at merge time.

## Why
Red-attacker groups tests by the _feature under test_, not by the _testing layer_. A single describe like `seedPersonas with seed=0` may contain three pure `seedPersonas()` calls (→ `persona-seed.test.ts`) and one `handleToolCall` end-to-end check (→ `server-handlers.test.ts`). Keeping the group intact forces inappropriate infrastructure into a pure test file.

## Pattern
For each red-attacker test, ask:
1. Does it call `handleToolCall` / use `SessionStore` / need `tmpDir`? → `server-handlers.test.ts`
2. Does it call only the pure module function directly? → that module's unit test file
3. Does it use the target file's existing state factory? Adapt helpers (e.g. replace `makeBaseState` with the file's `makeState`) rather than copying the red helper verbatim.

## Triage: Discard Tests Targeting Unchanged Code

Tests targeting functions that were **not changed** in the task should be discarded even if they reveal gaps in existing coverage. The criterion is not "does this test add value?" but "does this test target code that was changed?". Merging tests for unchanged code blurs the scope of the change and adds maintenance burden for coverage that could have been added by a dedicated test task.

Apply this triage before checking for overlap with existing tests:
- Step 1: List every function/module the red test exercises
- Step 2: Check if any of those were modified in this task
- Step 3: If none were modified, discard the block regardless of gap coverage

When adapting state factories, use the existing file's factory as a base and spread-override specific fields — matching the patterns already established in that file (e.g. `const base = makeState(); makeState({ agents: { alice: { ...base.agents.alice, banned: true } } })`).

## Gotcha: Red Tmp Imports Use Wrong Relative Depth

Red-attacker writes files to `.claude/coral/tmp/red/` and generates relative imports that are 4 levels up from the project root (e.g., `'../../../../src/codex/cli-detection.js'`). When copying to `src/codex/__tests__/`, update these to one level up (`'../cli-detection.js'`). Failing to do so causes module-not-found at test time without a clear error message pointing to the import.

Also valid: create a separate `*-red.test.ts` file when the red suite is large and coherent enough to stand alone, rather than appending to an existing test file. Use this when the red tests form their own logical adversarial grouping (edge cases, boundary values, race conditions) distinct from the happy-path structure of the source test file.

## Gotcha: Title-Assertion Mismatch in "Documenting Behavior" Tests

When the red-attacker finds surprising behavior (e.g., a predicate returns `true` where naive expectation is `false`), it sometimes names the test with the naive expectation ("returns false at step=1...") but writes the assertion correctly (`expect(result).toBe(true)`). Always read the assertion, not just the title, before merging. Fix the title to accurately describe actual behavior.

## Gotcha: Fragment Tests Overlap with Exact-String Tests

If the target file already has `expect(fn(x)).toBe('exact string')` tests, discard red-attacker tests that use `expect(fn(x)).toContain('fragment')` for the same inputs — strictly weaker coverage. Keep only tests that add genuinely new angles (distinctness across all values, pure-function idempotency, etc.).
