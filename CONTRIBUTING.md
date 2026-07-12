# Contributing

## Development

```bash
npm install
npm run build         # TypeScript compile + esbuild bundle to clients/build/ (prod flavor)
npm run build:dev     # TypeScript compile + esbuild bundle to clients/build/ (dev flavor)
npm run build:release # Build (prod) + copy clients/build/ to clients/bridge/
npm test          # Run tests with vitest
npm run dev       # TypeScript watch mode
```

See [docs/dev-setup.md](docs/dev-setup.md) for parallel dev/prod daemon setup.

## Git Workflow

- **`main`** is the only long-lived branch — protected (PR + 1 review), always deployable, never committed to directly.
- Branch from `main` with a `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, or `ci/` prefix and open a PR back to `main`.
- PRs are **squash-merged** (one commit per PR on `main`, traceable via `(#N)`). CI builds + tests on Node 24 and 26.
- Feature PRs carry **source only** — never bump the version or rebuild `clients/bridge/` (that is the Release workflow's job).

## PR Labels

Attach **one type label** to every PR, matching its title prefix (`feat:`→`feat`, `fix:`→`fix`, `refactor:`→`refactor`, `docs:`→`docs`, `test:`→`test`, `ci:`→`ci`, `chore:`→`chore`). Release notes are generated automatically from these labels, so label every PR — `gh pr create --label <type> …`.

## Commit Style

- Prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `ci:`, `chore:`
- Imperative mood: "add session fork support" not "added" or "adds"

See [`.claude/rules/conventions.md`](.claude/rules/conventions.md) for the full conventions (naming, TypeScript style, testing, releasing, and the label↔prefix mapping).
