# Contributing

## Development

```bash
npm install
npm run build     # TypeScript compile + esbuild bundle
npm test          # Run tests with vitest
npm run dev       # TypeScript watch mode
```

## Git Workflow

- **`main`**: Release branch. Always deployable.
- **`dev`**: Integration branch. Direct commits allowed for small changes.
- **Feature branches**: Branch from `dev`, rebase merge back via PR.
- **Release**: Squash merge `dev` → `main` via PR.

Merge policy:
- **feature → dev**: rebase (preserve individual commits)
- **dev → main**: squash (one commit per release, traceable via `(#N)`)

## Commit Style

Prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
Imperative mood: "add session fork support" not "added" or "adds"
