# Coral Test Migration Matrix

| Removed assertion intent (legacy `handleCoralAgent` path) | Destination test | Status |
|---|---|---|
| Bypass forcing on create (`bypass: false` input still launches with bypass enabled) | `src/providers/codex/__tests__/server-handlers.test.ts` — `create path prepends coral content and forces bypass=true` | migrated |
| Bypass forcing on resume | `src/providers/codex/__tests__/server-handlers.test.ts` — `resume path dispatches via executeResume with session cwd fallback and bypass=true` | migrated |
| Prompt composition on create (`coralContent + --- + prompt`) | `src/providers/codex/__tests__/server-handlers.test.ts` — `create path prepends coral content and forces bypass=true` | migrated |
| Prompt composition on resume | `src/providers/codex/__tests__/server-handlers.test.ts` — `resume path dispatches via executeResume with session cwd fallback and bypass=true` | migrated |
| Resume-path behavior uses `executeResume` (not one-shot) | `src/providers/codex/__tests__/server-handlers.test.ts` — `resume path dispatches via executeResume with session cwd fallback and bypass=true` | migrated |
| Session lookup ordering: missing session fails before CLI preflight | `src/providers/codex/__tests__/server-handlers.test.ts` — `session not in mgr returns error before CLI preflight` | migrated |
| Missing-agent error shape from coral resolution | `src/coral/__tests__/dispatch.test.ts` — `throws missing-content errors from resolver with stable shape` | migrated |
| Session naming explicit override (`name`) | `src/providers/codex/__tests__/server-handlers.test.ts` — `explicit name field overrides generated agentName-timestamp label` | migrated |
| Session naming generated fallback (`agentName-timestamp`) | `src/providers/codex/__tests__/server-handlers.test.ts` — `without explicit name, session_name follows agentName-timestamp pattern` | migrated |
| Resume uses stored working directory when request omits it | `src/providers/codex/__tests__/server-handlers.test.ts` — `resume path dispatches via executeResume with session cwd fallback and bypass=true` | migrated |
| Validation-routing: empty/missing prompt and invalid reasoning effort fail before downstream execution | `src/providers/codex/__tests__/server-handlers.test.ts` — `schema validation failures occur before execution` | migrated |

