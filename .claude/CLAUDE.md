# Coral - Development Instructions

Claude Code plugin providing structured agents, Codex and Claude CLI integrations, and moderated multi-agent discussions. Skills and hooks invoke Coral's CLI surfaces, which coordinate through a persistent backend daemon — primarily over an authenticated IPC socket, with HTTP exposed only as a remote gateway plus the `/health`, `/admin/shutdown`, and `/events/stream` carveouts — for provider execution, workflow dispatch, discuss operations, and knowledge-base tasks.

**Critical Requirements**:
- Zod schema validation on every CLI/backend input before execution
- Atomic file writes for session persistence (write to `.tmp`, then rename)
- Hook scripts must work as Node.js ESM (`.mjs`), read stdin, fail-open on errors
- SKILL.md frontmatter must match plugin.json tool/agent declarations
- **NEVER change version** (package.json) without explicit user request

**Key Documentation**:
- `docs/architecture.md` - System structure, data flow, module dependency graph
- `docs/design-rationale.md` - WHY behind the structure: authority duality, causal-graph faults, naming/subdivision policy with rejected anti-patterns
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
npm run build          # tsc + esbuild bundle to clients/build/ (prod flavor)
npm run build:dev      # tsc + esbuild bundle to clients/build/ (dev flavor)
npm run build:release  # build (prod) + copy clients/build/ to clients/bridge/
npm test             # vitest run
npm run dev          # tsc --watch
```

**Runtime Note**: `clients/bridge/*.cjs` bundles have build-time constants (`__PLUGIN_ROOT__`, `__VERSION__`) injected by esbuild. Do NOT execute them directly (`node clients/bridge/coral-cli.cjs`) — they only work from the installed plugin path. Use `npm test` for CLI verification.

**Releasing**:
Releases are cut by the manual **Release** GitHub Action (Actions → Run workflow → version), which runs tests, bumps the version, rebuilds `clients/bridge/`, makes a single `Release v<ver>` commit, tags `v<ver>`, and pushes to `main`. Do NOT bump the version or rebuild `clients/bridge/` in a feature PR — feature PRs carry source only. (Locally, `npm version <ver> --no-git-tag-version` updates `package.json`/`package-lock.json`, and `npm run build:release` then syncs the version into `clients/.claude-plugin/plugin.json`, the root `.claude-plugin/marketplace.json`, `clients/.codex-plugin/plugin.json`, `clients/.github/plugin/plugin.json`, the root `.github/plugin/marketplace.json`, rebuilds `clients/bridge/`, and injects `__VERSION__` — but the workflow is the canonical path.)

A release that should not have shipped is removed by the manual **Unrelease** Action, which deletes the release, the tag, and the `Release v<ver>` commit so the same version can carry a corrected build. It only acts when that commit is still `main`'s tip **and** was authored by the release App.

Rules in `.claude/rules/` are auto-loaded. Domain-specific rules activate based on file paths being edited via `paths:` frontmatter.

Good code guides readers naturally — structure reveals intent without requiring explanation.

## Workflow

**Before**: Read `docs/architecture.md` and `docs/core-modules.md` for the module being modified. Check `~/.coral/kb/notes/` for existing knowledge. Identify mandatory consultations from matrix in `.claude/rules/agents.md`.

**During**: Invoke domain agents per consultation matrix. On errors, check `~/.coral/kb/notes/` before debugging from scratch.

**After Implementation** (strict order, fail-fast by cost):

**Scope gate**: Steps 1-4 apply only when source-affecting files are modified (`src/`, `scripts/`, `package.json`, `tsconfig.json`). Non-source changes (`clients/agents/`, `clients/skills/`, `docs/`, `clients/hooks/`, `.claude/`) skip to step 5.

1. **Lint** - run linter if configured (cheapest check first)
2. **Review Gate** - invoke `Skill(tier-review)`. BLOCKING items must pass before build.
3. **Build** - `npm run build` (tsc + esbuild, must pass clean)
4. **Test** - `npm test` (vitest, all tests must pass and all errors must be zero. Never assume errors are "pre-existing" without tracing the stack and verifying the affected code was not modified.)
5. **KB update** - review work for `~/.coral/kb/notes/` promotion if non-obvious lessons were learned
6. **Commit** - stage and commit the project changes for this repo
