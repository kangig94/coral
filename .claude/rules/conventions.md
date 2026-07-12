# Conventions

## Git Workflow

- **`main`**: the only long-lived branch. Protected by the "protect main" ruleset (changes via PR + 1 review). Always deployable. Never commit directly.
- **Feature branches**: branch from `main`, open a PR back to `main`. Naming: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/` prefixes.
- **Merge**: squash (one commit per PR on `main`, traceable via PR link `(#N)`). CI (`.github/workflows/ci.yml`) builds + tests the PR on Node 24 and 26.

Feature PRs carry **source only**. Do **not** bump the version or rebuild `clients/bridge/` in a feature PR — both belong to the release step (see Releasing). CI does not check `clients/bridge/`, so a stale `clients/bridge/` on `main` between releases is expected and harmless (installs come from tags, see below).

## Releasing

Releases are cut by the manual **Release** GitHub Action, not by a PR:

1. Actions → **Release** → *Run workflow* → enter the version (semver, no leading `v`, e.g. `0.9.14`).
2. The workflow runs `npm test`, `npm version --no-git-tag-version`, and `npm run build:release` (which rebuilds `clients/bridge/` for that exact version and syncs the version into `clients/.claude-plugin/plugin.json`, the root `.claude-plugin/marketplace.json`, and `clients/.codex-plugin/plugin.json`). It then makes a single `Release v<version>` commit (version + rebuilt `clients/bridge/`), tags `v<version>`, pushes both to `main`, and creates a GitHub release.
3. It authenticates as a GitHub App listed in the "protect main" ruleset bypass, so it pushes the release commit directly to protected `main`.

The plugin installs from the tag (`marketplace.json` `source` is a `git-subdir` into `clients/` with `ref = v<version>` on `main` as the "latest" pointer; each tag carries the exact `clients/bridge/` for its version). The version level (patch/minor/major) is decided when cutting the release, not per PR.

## Commit Style

- Prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- Imperative mood: "add session fork support" not "added" or "adds"
- Body explains WHY, not WHAT (the diff shows what)
- Reference issue numbers when applicable

## Naming

- **Files**: kebab-case (`session-manager.ts`, `cli-detection.ts`)
- **Types/Interfaces**: PascalCase (`SessionEntry`, `CodexExecResult`)
- **Functions**: camelCase (`parseCodexJsonl`, `detectCodexCli`)
- **Constants**: UPPER_SNAKE for true constants (`MAX_BUFFER`, `DEFAULT_TIMEOUT`), camelCase for derived values
- **Zod schemas**: camelCase with `Schema` suffix (`codexOpSchema`, `discussSeedSchema`)
- **Contract-facing action names**: snake_case where the CLI/backend contract expects it (`discuss_seed`, `kb_search`)
- **Agent files**: kebab-case markdown (`integration-guardian.md`)
- **Skill directories**: kebab-case (`code-simplify/`)

## TypeScript Style

- Strict mode enabled. No `any` without justification.
- Prefer `type` over `interface` for unions and intersections.
- Use `interface` for object shapes that may be extended.
- Explicit return types on exported functions.
- Use `const` assertions where possible.
- Import with `.js` extension for ESM compatibility.

## Testing

- Framework: vitest
- Test files: `src/<module>/__tests__/<name>.test.ts` (e.g., `src/providers/__tests__/`, `src/discuss/__tests__/`)
- One test file per source module
- Test naming: `describe('<module>')` with `it('should <behavior>')`
- Mock external dependencies (Codex CLI, filesystem) — never call real Codex in tests
- Flaky tests: add `// @flaky — <reason>` comment at file/describe top, then `{ retry: 2 }` on the `describe` options. Timing-sensitive or shared-state tests go in `vitest/integration.ts` (pool: forks, singleFork) for process-level isolation.

## Error Handling

- Public-surface errors: return domain errors or structured responses that match the calling CLI/backend contract
- Zod validation errors: catch them at the entrypoint and surface clear user-facing errors
- Process spawn errors: wrap in descriptive messages with recovery hints
- File I/O errors: check error codes (`ENOENT` for missing, `SyntaxError` for corrupt JSON)

## Formatting

- No trailing whitespace
- Single blank line between top-level declarations
- JSDoc on exported functions and complex internal functions
- Comments explain WHY, not WHAT

## Localized Documentation

- `README.md` changes must be reflected in all `README.*.md` translations (e.g., `README.ko.md`)
- Keep structure and section order identical across versions
- Code blocks, URLs, and command examples stay in English — translate only prose
- Write natural prose in the target language, not literal translations — avoid "translationese"
