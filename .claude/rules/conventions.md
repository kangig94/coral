# Conventions

## Git Workflow

- **`main`**: the only long-lived branch. Protected by the "protect main" ruleset (changes via PR + 1 review). Always deployable. Never commit directly.
- **Feature branches**: branch from `main`, open a PR back to `main`. Naming: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/` prefixes.
- **Merge**: squash (one commit per PR on `main`, traceable via PR link `(#N)`). CI (`.github/workflows/ci.yml`) runs the full gate on Node 24 and 26: `typecheck:tests`, `lint`, `format:check`, `knip`, `build`, then the unit, integration, store-reset and lifecycle suites.

Feature PRs carry **source only**. Do **not** bump the version or rebuild `clients/bridge/` in a feature PR — both belong to the release step (see Releasing). CI does not check `clients/bridge/`, so a stale `clients/bridge/` on `main` between releases is expected and harmless (installs come from tags, see below).

## PR Labels

Every PR carries **exactly one type label** mapped from its title prefix. The label is what drives the changelog: the Release workflow groups merged PRs by label (see [`.github/release.yml`](../../.github/release.yml)), so an unlabeled PR falls under "Other Changes". Reuse GitHub's default labels where they express the same type.

| PR title prefix | Label           |
| --------------- | --------------- |
| `feat:`         | `enhancement`   |
| `fix:`          | `bug`           |
| `refactor:`     | `refactor`      |
| `docs:`         | `documentation` |
| `test:`         | `test`          |
| `ci:`           | `ci`            |
| `chore:`        | `chore`         |

Attach the label in the same step that opens the PR — `gh pr create --label <type> …` — never leave a PR unlabeled. Use the `ignore-for-release` label to omit a PR (e.g. a revert or pure no-op) from the release notes.

## Releasing

Releases are cut by the manual **Release** GitHub Action, not by a PR:

1. Actions → **Release** → *Run workflow* → enter the version (semver, no leading `v`, e.g. `0.9.14`).
2. The workflow runs the same full gate CI runs — it must not be a subset, or a release can ship what a pull request would have been rejected for — then `npm version --no-git-tag-version` and `npm run build:release` (which rebuilds `clients/bridge/` for that exact version and syncs the version into `clients/.claude-plugin/plugin.json`, the root `.claude-plugin/marketplace.json`, `clients/.codex-plugin/plugin.json`, `clients/.github/plugin/plugin.json`, and the root `.github/plugin/marketplace.json`). It then makes a single `Release v<version>` commit (version + rebuilt `clients/bridge/`), tags `v<version>`, pushes both to `main`, and creates a GitHub release.
3. It authenticates as a GitHub App listed in the "protect main" ruleset bypass, so it pushes the release commit directly to protected `main`.

The plugin installs from the tag (`marketplace.json` `source` is a `git-subdir` into `clients/` with `ref = v<version>` on `main` as the "latest" pointer; each tag carries the exact `clients/bridge/` for its version). The version level (patch/minor/major) is decided when cutting the release, not per PR.

## Unreleasing

Versions only move forward and a tag is never reused, so a release that should not have shipped cannot be corrected by re-tagging — it has to be removed completely before the same number can carry a corrected build. The manual **Unrelease** GitHub Action (Actions → **Unrelease** → *Run workflow* → version) deletes the GitHub release, deletes the tag, and force-pushes `main` past the `Release v<ver>` commit so no trace of the version remains.

It refuses unless `main`'s tip **is** that version's release commit, authored by the release App. Anything landing on top makes the release unremovable this way, by design: rewriting history under someone else's commits is a decision for a person, not a workflow. Use it while a bad release is fresh; once it has been installed, ship a forward version instead.

The GitHub release body is generated automatically (`gh release create --generate-notes`) from every PR merged since the previous release, grouped by the PR type labels above (see [PR Labels](#pr-labels)). The changelog is therefore only as good as the PR titles and labels — keep both correct.

## Commit Style

- Prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `ci:`, `chore:` (a PR's prefix maps to its label — see [PR Labels](#pr-labels))
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
- Comments state a constraint, never a description. "Is it WHY?" is the wrong test — a WHY that
  describes the current implementation rots exactly as fast as a WHAT. The test is **could an edit
  someone would plausibly make to this code in the normal course of work make this sentence false?**
  An arbitrary redesign does not count. If a legitimate edit can falsify it, delete the comment
  rather than write it, because the edit that invalidates it will not be the edit that notices.
  - A **constraint** survives rewriting, and breaking it is a bug: "a non-zero exit here must not
    be read as a settled no"; "unknown may not authorize finalization"; "`flock` opens the path
    `O_RDONLY|O_CREAT`, so a missing lock file exits 0 and is created". Measured facts about the
    world outside this repository are constraints too — cite what you measured and on what.
  - A **description** dies on contact with the next edit: what the code below does, which branch
    runs first, how many call sites there are, what another file currently says, what this used to
    be. All of it is re-derivable by reading the code, and none of it survives changing the code.
  - Rejected outright, as instances of description: change history (the VCS owns it); any claim about
    another file, quoted or paraphrased; prose restating the expression beneath it; a count of
    anything; a comment justifying an unreachable branch instead of deleting the branch.
  - An edited comment is a finding when the diff changed the code it describes and then edited the
    comment to keep that description true. Report the before and after text: the edit is the evidence
    that the description rotted. Replacing an already-bad description with a constraint is a repair,
    not that finding; judge the replacement by the same rot test as any added comment.
  - Refreshing is also permitted when a later diff re-measures an external fact or corrects its
    citation, or moves a pointer's named symbol or path. None of these permits keeping a description
    true as the code beneath it changes.
  - A description you must edit because the code changed slightly is the worst case, not a maintenance
    cost to accept. There is no third option that keeps it: **delete it.** Do not re-express it as a
    test or a type to preserve the sentence — that is the same claim implemented twice, and the
    duplicate rots the same way.
  - When a reader genuinely cannot follow this file without knowing where something else lives,
    leave a pointer and nothing else: `see doSomething in src/anything.ts`. A symbol name and a
    path, never a line number, never a summary of what is there. A line number is stale the next
    time anything above it moves; a symbol name is still findable when the file is reorganised, and
    wrong loudly when the symbol is gone.

## Localized Documentation

- `README.md` changes must be reflected in all `README.*.md` translations (e.g., `README.ko.md`)
- Keep structure and section order identical across versions
- Code blocks, URLs, and command examples stay in English — translate only prose
- Write natural prose in the target language, not literal translations — avoid "translationese"
