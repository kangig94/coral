---
paths:
  - "src/**/*.ts"
---

# Validation Checklists

## BLOCKING (Must Pass)

Work CANNOT be marked complete if any fail.

| Category | Check | Agent |
|----------|-------|-------|
| **Session** | Codex session writes use atomic pattern (`.tmp` + rename) | integration-guardian |
| **Session** | Corrupt session files are skipped, not crash | integration-guardian |
| **Session** | Discuss session writes use atomic pattern (`writeStateAtomic`) | integration-guardian |
| **Process** | Child processes tracked in `activeChildren` set | integration-guardian |
| **Process** | Timeout kills use SIGTERM then SIGKILL after delay | integration-guardian |
| **Process** | `killAllChildren()` called on server shutdown | integration-guardian |
| **Elegance** | Elegance Score >= 7 (code quality gate) | code-critic |
| **Elegance** | Follows established codebase patterns | code-critic |

## STRONG (Must Document)

If not addressed, must document reason in code comments or commit message.

| Category | Check | Agent |
|----------|-------|-------|
| **Schema** | Zod schemas match documented CLI flags and backend payload contracts | integration-guardian |
| **Schema** | Schema error messages are user-friendly | ux-critic |
| **Types** | Exported types have JSDoc comments | code-critic |
| **Test** | Changed modules have corresponding test updates | code-critic |
| **Error** | Error messages include recovery hints | ux-critic |
| **Discuss** | State machine functions are pure (no I/O) | code-critic |

## MINOR (Should Document)

| Category | Check | Agent |
|----------|-------|-------|
| **Naming** | Contract-facing JSON fields stay consistent with their documented naming; TypeScript stays camelCase | code-critic |
| **Docs** | Code comments explain WHY, not WHAT | code-critic |
| **Buffer** | Output buffers respect MAX_BUFFER limit | integration-guardian |
| **Hook** | Hook scripts use `try/catch` wrapper for fail-open behavior | hook-safety |
