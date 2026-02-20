# Coral - Development Instructions

Claude Code plugin providing structured agents with Codex CLI bridge. Exposes MCP tools (`codex_session_create`, `codex_session_send`, `codex_session_list`, `codex_session_fork`) over stdio transport. Includes skills (slash commands), hooks (SubagentStart delegation), and agent definitions for both Claude-native and Codex-delegated workflows.

**Critical Requirements**:
- MCP protocol compliance: all tool responses must use `{ content: [{ type: "text", text }], isError }` format
- Zod schema validation on every tool input before execution
- Never use `console.log` in MCP server code (stdio transport conflict)
- Atomic file writes for session persistence (write to `.tmp`, then rename)
- Hook scripts must be POSIX-portable (no bash-specific syntax, no `grep -P`)
- SKILL.md frontmatter must match plugin.json tool/agent declarations
- **NEVER change version** (package.json) without explicit user request

**Key Documentation**:
- `docs/architecture.md` - System structure, data flow, module dependency graph
- `docs/mcp-tools.md` - MCP tool specifications
- `docs/core-modules.md` - TypeScript module details
- `docs/agents.md` - Agent definitions and routing
- `docs/hooks.md` - Hook behavior and matchers
- `docs/skills.md` - Slash command usage
- `docs/build-system.md` - Build pipeline (tsc + esbuild)
- `docs/configuration.md` - Config and environment variables

**Build Commands**:
```bash
npm run build        # tsc + esbuild bundle
npm test             # vitest run
npm run dev          # tsc --watch
```

Rules in `.claude/rules/` are auto-loaded. Domain-specific rules activate based on file paths being edited via `paths:` frontmatter.
