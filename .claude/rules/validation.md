---
paths:
  - "src/**/*.ts"
---

# Validation Checklists

## BLOCKING (Must Pass)

Work CANNOT be marked complete if any fail.

| Category | Check | Agent |
|----------|-------|-------|
| **MCP Protocol** | Tool responses use `{ content: [{ type: "text", text }], isError }` format | mcp-guardian |
| **MCP Protocol** | Zod schema validates input before execution logic | mcp-guardian |
| **MCP Protocol** | No `console.log` in server code (stdio transport conflict) | mcp-guardian |
| **MCP Protocol** | Unknown tool names return isError response, not throw | mcp-guardian |
| **Session** | Session writes use atomic pattern (`.tmp` + rename) | mcp-guardian |
| **Session** | Corrupt session files are skipped, not crash | mcp-guardian |
| **Process** | Child processes tracked in `activeChildren` set | mcp-guardian |
| **Process** | Timeout kills use SIGTERM then SIGKILL after delay | mcp-guardian |
| **Process** | `killAllChildren()` called on server shutdown | mcp-guardian |
| **Elegance** | Elegance Score >= 7 (code quality gate) | code-critic |
| **Elegance** | Follows established codebase patterns | code-critic |

## STRONG (Must Document)

If not addressed, must document reason in code comments or commit message.

| Category | Check | Agent |
|----------|-------|-------|
| **Schema** | Zod schemas match MCP tool `inputSchema` declarations | mcp-guardian |
| **Schema** | Schema error messages are user-friendly | ux-critic |
| **Types** | Exported types have JSDoc comments | code-critic |
| **Test** | Changed modules have corresponding test updates | code-critic |
| **Error** | Error messages include recovery hints | ux-critic |

## MINOR (Should Document)

| Category | Check | Agent |
|----------|-------|-------|
| **Naming** | snake_case for MCP tool names, camelCase for TypeScript | code-critic |
| **Docs** | Code comments explain WHY, not WHAT | code-critic |
| **Buffer** | Output buffers respect MAX_BUFFER limit | mcp-guardian |
