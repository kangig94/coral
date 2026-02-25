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

When adapting state factories, use the existing file's factory as a base and spread-override specific fields — matching the patterns already established in that file (e.g. `const base = makeState(); makeState({ agents: { alice: { ...base.agents.alice, banned: true } } })`).
