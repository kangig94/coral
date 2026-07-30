---
name: equip
description: One-touch install of Coral companion tooling and KB runtime
argument-hint: "[--list | info <package> | [--update] <package> | uninstall <equipment-name>]"
---

# Equip

Install and configure Coral companion tooling for Claude Code.

## Verb Mapping

- `/equip <pkg>` -> `coral-cli expansion equip <pkg>`
- `/equip --list` -> `coral-cli expansion list`
- `/equip --update <pkg>` -> `coral-cli expansion update <pkg>`
- `/equip uninstall <pkg>` -> `coral-cli expansion unequip <pkg>`
- `/equip info <pkg>` -> `coral-cli expansion info <pkg>`
- `/equip` retired-residue cleanup diagnostics map to the public `coral-cli expansion remove-catalog <pkg>` command.

## Runtime Model

`coral-cli expansion` manages engines through the Expansion lifecycle. Engine identity is package-local; commands should route by declared metadata (`id`, `tier`, `fills`, `status`) instead of hard-coding package semantics.

- `fills` declares the runtime binding(s) an engine can provide, such as `kb.fts`, `kb.vector`, or `kb.embedding`.
- If an engine fills `kb.vector`, vector search can use it for vector queries. If no vector engine is equipped, vector queries fail with `binding_empty` until a vector engine is equipped.
- If an engine fills `kb.embedding`, engines that require embeddings can use that binding after the embedder is equipped.
- If an engine fills `kb.fts`, text search can use it for full-text queries.

## Tier Semantics

`coral-cli expansion list` and `coral-cli expansion info <pkg>` expose `tier` on engine entries.

| tier        | Status source                                                                                  | User verbs |
|-------------|------------------------------------------------------------------------------------------------|------------|
| `bundled`   | Coordinator bundled fallback pass; list/info show `tier: 'bundled'`, `status: 'equipped'`      | `equip` and `unequip` return `expansion_bundled_immutable` |
| `installed` | Installed-tier state row; list/info show `tier: 'installed'` plus state-row-derived `status`   | `equip`, `unequip`, and `update` manage install and activation |

Bundled engines auto-equip at coordinator boot via the bundled fallback pass. They do not appear in `expansion_state` (that table tracks installed-tier engines only). See `coral-cli expansion list` for status.

## Execution

### No argument or `--list`

1. Bash(`coral-cli expansion list`)
2. Parse the single-line JSON result.
3. Route read responses by top-level `status`:

| status    | Action |
|-----------|--------|
| `catalog` | Present the catalog as a table with `id`, `name`, `tier`, package `description`, `provides` when present, translated `activation`, `status`, `statusDescription` when present, `confirmDownload` when present, `targetDir` when present, and `cleanupCommand` when present. Render `provides` as sibling collections: `provides.capabilities` as a comma-separated capability label/name list and `provides.retrievalRoles` as a comma-separated role label list, for example `provides: capabilities=[Text (FTS), Vector (Semantic)]; retrievalRoles=[Text, Vector, Graph]`. Do not group capabilities by `typeTag`; it is opaque metadata |
| `info`    | Show the single package entry using the same package-status routing table below, including `tier`, `fills`/`slot` when present, `provides` when present using the same sibling collection rendering as catalog rows, and the translated `activation` label |
| `error`   | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

4. For each catalog entry, route inner `status` as follows:

| status                       | Meaning                                                         |
|------------------------------|-----------------------------------------------------------------|
| `equipped`                   | Active in the coordinator                                       |
| `catching_up`                | Registered and replaying the corpus                             |
| `installed-not-active`       | If `activation` is `remove-catalog`, this is residue from a retired expansion: recommend its exact `cleanupCommand` only when that field is present; when absent, show `lastError` and do not construct or run a cleanup command. Otherwise boot recovery failed, so check the last error and satisfy missing dependencies before retrying `/equip <name>` |
| `inactive`                   | Installed but not registered. Run `/equip <name>` to reactivate |
| `unavailable`                | Required local artifact missing or coordinator unreachable. Run `/equip <name>` to repair or reactivate |
| `disabled_pending_reinstall` | Load failed. Run `/equip <name>` to reinstall                   |
| `installing`                 | Another `/equip` is currently holding `install.lock`            |
| `not_equipped`               | Installed-tier engine is not installed/equipped locally         |
| `not_installed`              | Install-only package is not installed locally                   |
| `installed`                  | Install-only package is installed locally and ready to use      |

5. When rendering `activation`, translate internally:
   - `activation: 'equip'` -> `Active in Coordinator`
   - `activation: 'none'` -> `Install-only (use directly via the installed path)`
   - `activation: 'remove-catalog'` -> `Retired expansion residue (run the exact cleanupCommand only when provided; otherwise follow lastError without constructing a command)`
6. For bundled engines, do not suggest `/equip <name>` or `/equip uninstall <name>` as a repair action. These verbs return `expansion_bundled_immutable`; use `expansion list` to inspect status.
7. Ask the user which package to install.

### `<package>`

0. Unless this session already has a complete current `--list`/`info` entry for the package — including `activation` and whether `confirmDownload` is present — run `coral-cli expansion info <package>` first. Remembering only the activation is not sufficient.
1. **Retired residue gate.** If `activation` is `'remove-catalog'`, do not run `expansion equip`. When `cleanupCommand` is present, show that exact command, ask the user to confirm cleanup, and on confirmation run only Bash(`<exact cleanupCommand>`), parse its single-line JSON result, and stop. Never interpolate or reconstruct this command. When `cleanupCommand` is absent, show `lastError` and stop without running any command.
2. **Consent gate for install-only packages.** If `activation` is `'none'` and the current entry includes `confirmDownload`, show that message exactly and ask the user to confirm. It describes the package's actual download and preservation behavior; do not replace it with a generic remote-script warning. If the field is absent, explain that the package may run its own remote install script through the shell, then ask for confirmation. If the user declines, stop without running equip. (Engine packages — `activation: 'equip'` — need no extra prompt; proceed directly.) The install runs synchronously and progress is not streamed back, so explain that the final result may take time.
3. Bash(`coral-cli expansion equip <package>`)
4. Parse the single-line JSON result.
5. Route by `status`:

| status               | Action                                                                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `already_installed`  | Inform user; `expansion equip` continues activation when applicable. For install-only results, apply the no-change case in the shared install-only result routing in the `--update <package>` section below                                                                   |
| `already_up_to_date` | Inform user with version; `expansion equip` continues activation when applicable. For install-only results, apply the no-change case in the shared install-only result routing in the `--update <package>` section below                                                      |
| `installed`          | Show method used. For install-only results, apply the changed case in the shared install-only result routing in the `--update <package>` section below                                                        |
| `updated`            | Show method and version. For install-only results, apply the changed case in the shared install-only result routing in the `--update <package>` section below                                                 |
| `equipped`           | Expansion is installed and active in the coordinator (equipment-backed packages only)                                                                                                                                                                                      |
| `catching_up`        | Expansion is activating; tell the user to poll `/equip --list` until it reaches `equipped`                                                                                                                                                                                 |
| `already_equipped`   | Inform the user the expansion is already active                                                                                                                                                                                                                            |
| `error`              | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields                                                                                                                                      |

6. Apply the shared install-only result routing in the `--update <package>` section below when the mutation result is install-only.
7. Onboarding runs inside `coral-cli expansion equip <package>` before install/activate:
   - `engine_env_var_missing`: show the missing `envVar` and remediation exactly. Do not suggest restart/retry loops.
   - `binding_required`: show `suggestions` when present; otherwise show candidate ids from `context.candidates` when present. The user should equip one engine that fills the missing binding, then retry the original package.
   - `user_cancelled`: stop without retrying automatically.
8. Do not run `coral-cli expansion equip <package>` a second time unless the user has changed the missing setup state or equipped a required peer engine.

### `--update <package>`

0. Apply the same current-entry preflight as `<package>`: unless this session has a complete current entry including `activation` and whether `confirmDownload` is present, run `coral-cli expansion info <package>`.
1. Apply the same retired-residue gate. For `activation: 'none'`, apply the same consent gate before update: when `confirmDownload` is present, show that message exactly and ask for confirmation; when absent, show the shell-installer warning and ask for confirmation. If declined, stop without running update.
2. Bash(`coral-cli expansion update <package>`)
3. Parse the single-line JSON result.
4. Route by `status`:

| status               | Action                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `already_up_to_date` | Inform user with version. For install-only results, apply the no-change case in the shared install-only result routing below            |
| `updated`            | Show method and version. For install-only results, apply the changed case in the shared install-only result routing below               |
| `equipped`           | Expansion is updated and active in the coordinator                                                                                    |
| `catching_up`        | Expansion is updated and activating; tell the user to poll `/equip --list` until it reaches `equipped`                                |
| `already_equipped`   | Inform the user the updated expansion is already active                                                                               |
| `error`              | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

5. Apply the shared install-only result routing below: use the changed case for `updated` and the no-change case for `already_up_to_date`.
6. `update` is equivalent to `equip` when the local version differs from the catalog version; `/equip <package>` also updates implicitly. Use `/equip --update <package>` when the user is explicitly asking to bump or refresh the installed version.

#### Shared install-only result routing

- Changed results:
  - `method: 'runtime-download'`: show `targetDir` when present and say no coding-agent restart is required. When `ko` is enabled and the backend is active, Kiwi recovery and Korean reindex proceed live; otherwise the artifacts are ready for the next backend start or for when `ko` is enabled.
  - Other methods: show the executable `command` when present. Mention an agent restart only when that installer registered or updated agent tooling.
- No-change results:
  - `method: 'runtime-download'`: show `targetDir` when present and explain that the artifacts were already valid, so this command started neither a download nor a reindex. Do not promise an analyzer upgrade. Unconditionally offer this next step: if Korean search is still not using Kiwi, the user can run `coral-cli backend shutdown` so the next command restarts the backend and retries initialization; if that retry also fails, check artifact filesystem permissions and report the repeated error.
  - Other methods: show the existing `command` when present without claiming that the installer ran or that a restart is required.

### `info <package>`

1. Bash(`coral-cli expansion info <package>`)
2. Parse the single-line JSON result.
3. Show the status and, when returned, the package `tier`, `provides.capabilities`, `confirmDownload`, `targetDir`, `addonPath`, installed `command`, retired-residue `cleanupCommand`, `userMessage`, and `remediation`. Show `confirmDownload` exactly so the user can inspect any source, size, and preservation disclosure before equip or update. Treat an error result as terminal.

### `uninstall <equipment-name>`

1. Bash(`coral-cli expansion unequip <equipment-name>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status         | Action                                                                                                           |
|----------------|------------------------------------------------------------------------------------------------------------------|
| `uninstalled`  | For install-only packages, confirm the local installation or runtime artifacts were removed directly. For installed-tier engines, confirm removal through the coordinator-owned catalog-removal transaction |
| `not_equipped` | Inform user the engine was already not equipped; treat as success                                                |
| `error`        | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

4. `unequip` for installed-tier engines asks the coordinator to remove the catalog entry transactionally, which disposes any live scope without running bundled fallback, unregisters manifest-scoped capability declarations when allowed, and then removes local artifacts. For install-only packages, it removes the local installation or runtime artifacts.

## Notes

- Install-only binaries and engine artifacts both land under the engine data tree (`~/.coral/data/engines/<engine>/`, or `~/.coral/data-dev/engines/<engine>/` when `CORAL_FLAVOR=dev`). Shell-installer results report the executable path as `command`; pinned runtime-download results report their artifact root as `targetDir`
- Corpus indexes stay under `~/.coral/data/kb/` in prod or `~/.coral/data-dev/kb/` in dev
- These data paths are account-neutral. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` select provider credentials per invocation and never change the Coral daemon or state root
- Some installed engines may have native artifacts or model downloads; follow the `userMessage` and `remediation` returned by the CLI for missing prerequisites.
- An install-only package (`activation: 'none'`) may use a shell installer or Coral's pinned `runtime-download` path. Read `confirmDownload` and the returned `method` instead of assuming a remote script. Only shell installers that register coding-agent tooling require a coding-agent restart. With Kiwi runtime downloads, recovery and reindex are live only when `ko` is enabled and the backend is active.
- On Windows, `unequip` after activation may require a Coral restart when a loaded native addon remains mapped for the coordinator process lifetime.
