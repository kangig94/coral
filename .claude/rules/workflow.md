# Development Workflow

## Phase 1: Before Implementation

1. Read relevant documentation:
   - `docs/architecture.md` for system structure and data flow
   - `docs/core-modules.md` for the module you are modifying
   - `.claude/coral/kb/` for memoized debugging lessons in the relevant domain

2. Identify mandatory consultations using the Consultation Matrix in `.claude/rules/agents.md`

3. Check `.claude/coral/kb/` for existing knowledge before debugging from scratch

## Phase 2: During Implementation

1. Invoke domain agents for guidance:
   ```
   @mcp-guardian Review this tool handler pattern
   @hook-safety Check this hook script change
   ```

2. On errors: check `.claude/coral/kb/` before debugging from scratch

3. Key invariants to maintain:
   - Zod validation runs before any tool execution logic
   - `process.stderr.write` for diagnostics, never `console.log`
   - Session writes are atomic (`.tmp` + rename)
   - Hook scripts are POSIX-portable

## Phase 3: After Implementation (strict order, fail-fast by cost)

1. **Lint**: Run linter if configured (cheapest check first)

2. **Review Gate** (before build): Invoke review-orchestrator for final validation (mandatory for non-trivial work). BLOCKING items must pass before proceeding to build.

3. **Build**:
   ```bash
   npm run build    # tsc + esbuild -- must pass clean
   ```

4. **Test**:
   ```bash
   npm test         # vitest -- all tests must pass
   ```

5. **KB update**: Review work for `.claude/coral/kb/` promotion if non-obvious lessons were learned

## Build Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | TypeScript compile + esbuild bundle |
| `npm test` | Run vitest test suite |
| `npm run dev` | TypeScript watch mode |
| `npm run build:server` | esbuild bundle only (skip tsc) |
