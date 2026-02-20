# Conventions

## Git Workflow

- **`main`**: Release branch. Always deployable. Never commit directly.
- **`dev`**: Integration branch. Feature branches merge here.
- **Feature branches**: Branch from `dev`, merge back to `dev` via PR or merge.
- **Release**: When `dev` is stable, merge `dev` → `main` and bump version.
- **Hotfix**: Fix on `dev`, merge to `main`. Cherry-pick if `dev` has unreleased WIP.

Branch naming: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/` prefixes.

Merge policy: **rebase only**. Keep linear history on `main` and `dev`.

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
- **Zod schemas**: camelCase with `Schema` suffix (`codexSessionCreateSchema`)
- **MCP tool names**: snake_case (`codex_session_create`)
- **Agent files**: kebab-case markdown (`mcp-guardian.md`)
- **Skill directories**: kebab-case (`codex-ralph/`)

## TypeScript Style

- Strict mode enabled. No `any` without justification.
- Prefer `type` over `interface` for unions and intersections.
- Use `interface` for object shapes that may be extended.
- Explicit return types on exported functions.
- Use `const` assertions where possible.
- Import with `.js` extension for ESM compatibility.

## Testing

- Framework: vitest
- Test files: `src/mcp/__tests__/<module>.test.ts`
- One test file per source module
- Test naming: `describe('<module>')` with `it('should <behavior>')`
- Mock external dependencies (Codex CLI, filesystem) -- never call real Codex in tests

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
