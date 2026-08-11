# Build System

TypeScript compilation plus esbuild bundling for the current Coral runtime, with explicit prod and dev flavor builds.

## Build Commands

| Command                                                          | Description                                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run clean:dist`                                             | Remove `dist/` so deleted source paths cannot survive in package output                                                                        |
| `npm run build`                                                  | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle to `clients/build/` (prod flavor)                       |
| `npm run build:dev`                                              | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle to `clients/build/` (dev flavor)                        |
| `npm run build:release`                                          | Clean `dist/`, TypeScript compile, simulation compatibility check, plus esbuild bundle (prod), then copy `clients/build/` to `clients/bridge/` |
| `npm run check:simulation`                                       | Typecheck `tools/simulation` against `src` and verify sealing                                                                                  |
| `npm run simulate -- tools/simulation/scenarios/<scenario.yaml>` | Run the debug-only simulation harness                                                                                                          |
| `npm run dev`                                                    | TypeScript watch mode                                                                                                                          |
| `npm test`                                                       | Run the test suite                                                                                                                             |

## Build Flavors

`scripts/build-server.mjs` accepts `--flavor prod|dev` and `--release`. `npm run build` passes `--flavor prod`, `npm run build:dev` passes `--flavor dev`, and `npm run build:release` passes `--flavor prod --release`. Omitting `--flavor` defaults to `prod`. Flavor is selected explicitly by the build command, not inferred from `NODE_ENV`.

Flavor is injected into every bundle together with `version`, `buildSetId`, and the canonical `storeFormatFingerprint`. The adjacent `manifest.json` repeats that embedded identity and carries content hashes for the backend, CLI, and Claude helper. A bundle set is accepted only when the embedded and adjacent identities agree and all three hashes match. See `docs/dev-setup.md` for parallel dev/prod daemon usage.

## Build Output and Bridge

Build output goes to `clients/build/` (git-ignored). The committed runtime bundles in `clients/bridge/` are rebuilt by `npm run build:release` and are refreshed on `main` only by the **Release** workflow (`.github/workflows/release.yml`) — not in feature PRs. The committed bundles are:

- `clients/bridge/coral-backend.cjs`
- `clients/bridge/coral-cli.cjs`
- `clients/bridge/coral-claude-appserver.cjs`
- `clients/bridge/manifest.json`

`clients/bridge/` is not checked per-PR: PR CI (`.github/workflows/ci.yml`) only builds and tests. `clients/bridge/` is regenerated for the exact version and committed by the Release workflow at release time, so each release **tag** carries the matching bundles (the plugin installs from tags). Between releases, `clients/bridge/` on `main` is the previous release's build — expected and harmless, since installs never come from `main`'s HEAD.

## Build Pipeline

```text
src/**/*.ts
  │
  ▼  clean:dist (`scripts/clean-dist.mjs`)
dist/ removed
  │
  ▼  tsc
dist/**/*.js + dist/**/*.d.ts
  │
  ▼  check:simulation (`tsc -p tsconfig/simulation.json` + sealing)
  │
  ▼  esbuild (`scripts/build-server.mjs`)
clients/build/coral-backend.cjs
clients/build/coral-cli.cjs
clients/build/coral-claude-appserver.cjs
clients/build/manifest.json (`{ "version", "buildSetId", "bundleHash", "cliBundleHash", "claudeAppserverBundleHash", "flavor", "storeFormatFingerprint" }`)
  │
  ▼  --release (copy to clients/bridge/)
clients/bridge/*
```

The runtime is anchored by two primary entry points:

| Entry point                    | Output                            | Role           |
| ------------------------------ | --------------------------------- | -------------- |
| `src/coordinator/bootstrap.ts` | `clients/build/coral-backend.cjs` | Backend daemon |
| `src/cli/bootstrap.ts`         | `clients/build/coral-cli.cjs`     | CLI entrypoint |

The build script also emits `clients/build/coral-claude-appserver.cjs` from `src/providers/claude/appserver/server.ts` for the Claude broker helper runtime. The filename is retained for bridge compatibility; the helper defaults to `claude -p` stream-json and can use the PTY TUI transport when `CORAL_CLAUDE_TRANSPORT=tui`.

### Backend Entry Point Dispatch

`coral-backend.cjs` is one artifact with six dispatch modes. Before `src/coordinator/bootstrap.ts`'s `main()` constructs the ordinary coordinator, it checks argv and env for five other invocations of that same artifact and returns without ever reaching `createCoordinatorServer`:

| Invocation                                                                                                    | Behavior                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--print-store-format-fingerprint`                                                                              | Prints the canonical store-format fingerprint and exits                                                                              |
| `--print-store-reset-build-identity`                                                                            | Prints the strict embedded build identity as JSON and exits                                                                          |
| `--provider-guardian <capsulePath>` \| `--provider-reaper <capsulePath>` \| `--provider-proxy <capsulePath>`   | Dispatches into one provider-proxy role process instead of the coordinator — `src/provider-proxy/role-argv.ts` parses the flag, `role-main.ts` runs the named role |
| `CORAL_KB_DAEMON=1` (env)                                                                                        | Runs the KB daemon main instead of the coordinator                                                                                    |
| `--smoke-open-store --path <dbPath>`                                                                            | Opens the named store file, round-trips one row inside a transaction, and exits — a build/release smoke check                        |
| (none of the above)                                                                                              | Ordinary coordinator construction (`createCoordinatorServer`)                                                                         |

The three provider-role flags are one dispatch branch in `main()` — `parseProviderRoleArgv` refuses more than one role flag per invocation — but name three distinct roles (guardian, reaper, proxy) documented under [Provider proxy](./architecture.md#module-map).

## Build Script Responsibilities

The npm build commands run `scripts/clean-dist.mjs` before `tsc`. TypeScript
does not delete outputs for source files that were removed or moved, so cleaning
`dist/` before compile is required for `package.json`'s `dist/` export to match
the current `src/` tree.

`scripts/build-server.mjs` does six things:

1. Runs simulation compatibility verification (`check-simulation.mjs`), which typechecks `tools/simulation` against `src` and verifies sealing.
2. Reads `package.json` as the single source of truth for the version.
3. Syncs that version into `clients/.claude-plugin/plugin.json`, `clients/.codex-plugin/plugin.json`, `clients/.github/plugin/plugin.json`, the root `.claude-plugin/marketplace.json`, and the root `.github/plugin/marketplace.json`.
4. Bundles the backend, CLI, and Claude broker helper to `clients/build/` using
   the shared production options in `scripts/server-esbuild-options.mjs`.
5. Builds a probe backend to obtain the canonical store-format fingerprint, rebuilds with that fingerprint embedded, and atomically writes `clients/build/manifest.json` with the shared identity plus hashes for the backend, CLI, and Claude helper.
6. Runs `scripts/verify-kiwi-runtime-build-contract.mjs` against `clients/build`, checking the exact staging inventory and executing an isolated Kiwi initializer built from source with the same production esbuild options and an empty `NODE_PATH`.

When `--release` is passed, it additionally copies all artifacts from `clients/build/` to `clients/bridge/`.

Every `npm run build` performs the Kiwi runtime-build verification in step 6.
`npm run verify:kiwi-runtime-build` also exposes that verifier as a standalone
check: it checks the selected bundle directory's four-file inventory, then
builds and executes an isolated Kiwi initializer from source with those same
production esbuild options and an empty `NODE_PATH`.
This feature-build check does not regenerate `clients/bridge`; the Release
workflow performs that copy, and `npm run verify:store-reset-release`
separately verifies byte equality and package allowlisting.

The standalone Kiwi runtime-build contract can be reproduced locally with:

```bash
npm run build
npm run verify:kiwi-runtime-build
```

`bundleHash`, `cliBundleHash`, and `claudeAppserverBundleHash` bind the complete executable set. `version`, `buildSetId`, `flavor`, and `storeFormatFingerprint` are embedded and compared separately, so a mixed or stale artifact set fails closed even when one file happens to have unchanged bytes.

## esbuild Settings

| Setting                               | Value                            | Reason                                                                                                              |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bundle`                              | `true`                           | Single-file deployable bundles                                                                                      |
| `platform`                            | `node`                           | Node.js runtime target                                                                                              |
| `target`                              | `node22`                         | Conservative transpilation target below the supported Node 24 runtime floor                                         |
| `format`                              | `cjs`                            | Bundles are committed as `.cjs`                                                                                     |
| `external`                            | `['node:*', '@lydell/node-pty']` | Keep Node built-ins and native modules external (the store uses the built-in `node:sqlite`, so no `better-sqlite3`) |
| `minify`                              | `true`                           | Smaller committed bundles                                                                                           |
| `banner`                              | plugin root + embedded identity  | Runtime plugin-root discovery and human-inspectable build-set identity                                              |
| `define.__VERSION__`                  | `package.json` version           | Shared build-time version injection                                                                                 |
| `define.__BUILD_SET_ID__`             | generated UUID                   | Exact build-set binding                                                                                             |
| `define.__BUILD_FLAVOR__`             | explicit build flavor            | Intrinsic prod/dev identity                                                                                         |
| `define.__STORE_FORMAT_FINGERPRINT__` | built backend fingerprint        | Bind reporting and store format to the executable set                                                               |
| `define.__IS_CORAL_BACKEND_MAIN__`    | backend bundle only              | Guards backend auto-start behavior                                                                                  |

## Build-time Injections

| Constant                       | Source                        | Usage                                                   |
| ------------------------------ | ----------------------------- | ------------------------------------------------------- |
| `__VERSION__`                  | `package.json`                | Backend health/version output and CLI version reporting |
| `__BUILD_SET_ID__`             | generated once per build      | Reject mixed artifacts and cross-build incident reads   |
| `__BUILD_FLAVOR__`             | `--flavor prod` or `dev`      | Bind executables to the prod/dev state tree             |
| `__STORE_FORMAT_FINGERPRINT__` | probe backend output          | Bind executable identity to the exact store contract    |
| `__PLUGIN_ROOT__`              | CJS banner using `__dirname`  | Resolve plugin-relative assets at runtime               |
| `__IS_CORAL_BACKEND_MAIN__`    | build script                  | Backend main-entry guard                                |

Unbundled hooks read the adjacent manifest; bundled runtimes compare that same manifest with their injected identity and the hashes of all three adjacent executables.

## Dependencies

The build and runtime no longer depend on `@modelcontextprotocol/sdk`. Current package-managed runtime concerns are ordinary Node/TypeScript concerns: `zod` for schema validation, `esbuild` for bundling, native runtime packages such as `@lydell/node-pty` (prebuilt-binary fork — ships per-platform `.node` via optional dependencies, so install needs no native toolchain or lifecycle scripts), and the Coral runtime packages declared in `package.json`.

`kiwi-nlp` is exact-pinned in `package.json` (no caret). `src/engines/kiwi/constants.ts` hardcodes the matching package archive, WASM, and model digests and sizes, so a dependency bump must update the pin and constants together or artifact installation fails at runtime.

## Testing

Tests run with:

```bash
npm test
```

That command runs the repo typecheck, `tests/unit/**` plus `tests/invariants/**`, and the debug-only simulation harness. Those suites cover CLI routing, client helpers, backend handlers, providers, workflow execution, KB behavior, discuss behavior, and shared contracts. `npm run test:simulation` is only a narrower single-batch shortcut for the harness.

It does **not** run `tests/integration/**`, which owns the multi-process suites — cross-version handoff, cold and warm start, and IPC carriage. Those need their own command:

```bash
npm run test:integration
```

Both are CI steps, so a change that only passes one of them is not verified. The end-to-end suites are separate again (`tests/e2e/**`, see the store-reset list below).

Store-reset contract changes can be reproduced locally with:

```bash
npm run test:store-reset
npm run test:store-reset:integration
npm run build
npm run verify:store-reset-build
npm run test:e2e:store-reset:build
```

Backend lifecycle end-to-end coverage is a separate suite again, unrelated to store-reset but also a CI step — it spawns long-lived backend subprocesses and waits through startup, the IPC handshake, and process death across namespace-isolation and child/no-handoff cold-start cases:

```bash
npm run test:e2e:lifecycle
```

`npm run test:network` is not part of the PR gate — it runs `kiwi-runtime-download.integration.test.ts` against the real network to verify the pinned Kiwi WASM artifact still downloads and hashes clean, on CI's weekly schedule and on manual dispatch only.

## Release Notes

The **Release** workflow creates the GitHub release with `gh release create --generate-notes`, which builds the release body automatically from every PR merged since the previous release. GitHub's generator is **PR- and label-based** — it uses PR titles for the entries and groups them by label; it does **not** parse commit-message prefixes. Categories are defined in [`.github/release.yml`](../.github/release.yml), and the "one type label per PR" rule plus the label↔prefix mapping live in [`.claude/rules/conventions.md` § PR Labels](../.claude/rules/conventions.md). An unlabeled PR falls under "Other Changes"; the `ignore-for-release` label omits a PR entirely.

## Claude Code Integration

Claude Code reaches Coral through the plugin directory, hooks, and Bash-invoked `coral-cli`. There is no separate server-registration file and no stdio proxy bundle in the build.
