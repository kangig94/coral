# Coral - Development Instructions

Claude Code plugin providing structured agents with Codex and Claude CLI bridges and moderated multi-agent discussions. Exposes two MCP servers: `ax` for Codex and Claude CLI tools and `dc` for discuss tools. Includes skills (slash commands), hooks (lifecycle injection), and agent definitions for Claude-native, Codex-delegated, and discuss workflows.

**Critical Requirements**:
- MCP protocol compliance: all tool responses must use `{ content: [{ type: "text", text }], isError }` format
- Zod schema validation on every tool input before execution
- Never use `console.log` in MCP server code (stdio transport conflict)
- Atomic file writes for session persistence (write to `.tmp`, then rename)
- Hook scripts must work as Node.js ESM (`.mjs`), read stdin, fail-open on errors
- SKILL.md frontmatter must match plugin.json tool/agent declarations
- **NEVER change version** (package.json) without explicit user request

**Key Documentation**:
- `docs/architecture.md` - System structure, data flow, module dependency graph
- `docs/mcp-tools.md` - MCP tool specifications
- `docs/core-modules.md` - TypeScript module details
- `docs/agents.md` - Agent definitions and routing
- `docs/methodology.md` - HOW methodology system, agent/skill connections
- `docs/hooks.md` - Hook behavior and matchers
- `docs/skills.md` - Slash command usage
- `docs/build-system.md` - Build pipeline (tsc + esbuild)
- `docs/configuration.md` - Config and environment variables
- `docs/discuss.md` - Discuss system design

**Build Commands**:
```bash
npm run build        # tsc + esbuild bundle
npm test             # vitest run
npm run dev          # tsc --watch
```

**Version Upgrade**:
Run `npm version <ver> --no-git-tag-version` then `npm run build`. The npm command updates both `package.json` and `package-lock.json`. The build script syncs the version to `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`, and injects `__VERSION__` into the bundle.

Rules in `.claude/rules/` are auto-loaded. Domain-specific rules activate based on file paths being edited via `paths:` frontmatter.

Good code guides readers naturally — structure reveals intent without requiring explanation.

## Workflow

**Before**: Read `docs/architecture.md` and `docs/core-modules.md` for the module being modified. Check `.claude/coral/kb/` for existing knowledge. Identify mandatory consultations from matrix in `.claude/rules/agents.md`.

**During**: Invoke domain agents per consultation matrix. On errors, check `.claude/coral/kb/` before debugging from scratch.

**After Implementation** (strict order, fail-fast by cost):

**Scope gate**: Steps 1-4 apply only when source-affecting files are modified (`src/`, `scripts/`, `package.json`, `tsconfig.json`). Non-source changes (`agents/`, `skills/`, `docs/`, `hooks/`, `.claude/`) skip to step 5.

1. **Lint** - run linter if configured (cheapest check first)
2. **Review Gate** - invoke `Skill(tier-review)`. BLOCKING items must pass before build.
3. **Build** - `npm run build` (tsc + esbuild, must pass clean)
4. **Test** - `npm test` (vitest, all tests must pass and all errors must be zero. Never assume errors are "pre-existing" without tracing the stack and verifying the affected code was not modified.)
5. **KB update** - review work for `.claude/coral/kb/` promotion if non-obvious lessons were learned
6. **Commit** - stage and commit all changes including KB files (KB update precedes commit so kb/ changes are part of the same commit)
