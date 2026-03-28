# Conventions

## Git Workflow

- **`main`**: Release branch. Always deployable. Never commit directly.
- **`dev`**: Integration branch. Feature branches merge here. Direct commits allowed for small changes.
- **Feature branches**: Branch from `dev`, rebase merge back to `dev` via PR.
- **Release**: When `dev` is stable, squash merge `dev` → `main` via PR.
- **Hotfix**: Fix on `dev`, squash merge to `main`. Cherry-pick if `dev` has unreleased WIP.

Branch naming: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/` prefixes.

Merge policy:
- **feature → dev**: rebase (preserve individual commits, partial revert possible)
- **dev → main**: squash (one commit per release, traceable via PR link `(#N)`)

PR procedure (dev → main):
1. Commit all changes on `dev`, run build + tests
2. `git fetch origin main`
3. Rebase only new commits onto main:
   ```bash
   git rebase --onto origin/main \
     $(gh pr list --base main --head dev --state merged --limit 1 --json headRefOid -q '.[0].headRefOid') dev
   ```
   This finds the last squash-merged PR's head SHA on dev and replays only commits after it.
   If dev is already rebased (no prior squash-merged PR exists), use `git rebase origin/main` instead.
   This works even when main moved forward from other sources (hotfix, other contributor) —
   the rebase places new commits on top of the latest main regardless of divergence.
   On conflict: resolve, `git add`, `git rebase --continue`.
4. Verify: `git log --oneline origin/main..dev` should show only new commits
5. `npm run build && npm test` - re-verify after rebase
6. `git push origin dev --force-with-lease`
7. `gh pr create --base main --head dev` (or update existing PR)
8. Squash merge on GitHub

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
- **Zod schemas**: camelCase with `Schema` suffix (`codexOpSchema`, `discussLeadOpSchema`)
- **MCP tool names**: unified MCP tool name (`codex`, `discuss`, `discuss_lead`) plus required `op` field for command selection
- **Agent files**: kebab-case markdown (`mcp-guardian.md`)
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
- Test files: `src/codex/__tests__/<module>.test.ts` and `src/discuss/__tests__/<module>.test.ts`
- One test file per source module
- Test naming: `describe('<module>')` with `it('should <behavior>')`
- Mock external dependencies (Codex CLI, filesystem) — never call real Codex in tests
- Flaky tests: add `// @flaky — <reason>` comment at file/describe top, then `{ retry: 2 }` on the `describe` options. Timing-sensitive or shared-state tests go in `vitest.integration.config.ts` (pool: forks, singleFork) for process-level isolation.

## Error Handling

- MCP tool errors: return `{ content: [{ type: "text", text: "Error: ..." }], isError: true }`
- Zod validation errors: caught in the switch handler, surfaced as MCP error responses
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
