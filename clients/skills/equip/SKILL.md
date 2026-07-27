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
| `catalog` | Present the catalog as a table with `id`, `name`, `tier`, package `description`, `provides` when present, translated `activation`, `status`, `statusDescription` when present, and `cleanupCommand` when present. Render `provides` as sibling collections: `provides.capabilities` as a comma-separated capability label/name list and `provides.retrievalRoles` as a comma-separated role label list, for example `provides: capabilities=[Text (FTS), Vector (Semantic)]; retrievalRoles=[Text, Vector, Graph]`. Do not group capabilities by `typeTag`; it is opaque metadata |
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

0. Unless you already know the package's `activation` from a prior `--list`/`info` in this session, run `coral-cli expansion info <package>` first.
1. **Retired residue gate.** If `activation` is `'remove-catalog'`, do not run `expansion equip`. When `cleanupCommand` is present, show that exact command, ask the user to confirm cleanup, and on confirmation run only Bash(`<exact cleanupCommand>`), parse its single-line JSON result, and stop. Never interpolate or reconstruct this command. When `cleanupCommand` is absent, show `lastError` and stop without running any command.
2. **Consent gate for install-only packages.** If `activation` is `'none'`, equipping runs the package's own install script through your shell (typically `curl … | bash`) — code Coral fetches from a remote host and executes. Tell the user the package id and that equipping will download and run a remote install script, then ask them to confirm. If they decline, stop without running equip. (Engine packages — `activation: 'equip'` — need no extra prompt; proceed directly.) The install runs synchronously and its script output is not streamed back — only the final status returns — so tell the user it may take up to a minute before reporting.
3. Bash(`coral-cli expansion equip <package>`)
4. Parse the single-line JSON result.
5. Route by `status`:

| status               | Action                                                                                                           |
|----------------------|------------------------------------------------------------------------------------------------------------------|
| `already_installed`  | Inform user; `expansion equip` continues activation when applicable                                              |
| `already_up_to_date` | Inform user with version; `expansion equip` continues activation when applicable                                 |
| `installed`          | Show method used. For install-only packages, show `command` when present, then tell the user to restart their coding agent so any tooling the install script registered (e.g. an MCP server) takes effect |
| `updated`            | Show method and version. For install-only packages, show `command` when present, then tell the user to restart their coding agent for the updated tooling to take effect |
| `equipped`           | Expansion is installed and active in the coordinator (equipment-backed packages only)                            |
| `catching_up`        | Expansion is activating; tell the user to poll `/equip --list` until it reaches `equipped`                       |
| `already_equipped`   | Inform the user the expansion is already active                                                                  |
| `error`              | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

6. Onboarding runs inside `coral-cli expansion equip <package>` before install/activate:
   - `engine_env_var_missing`: show the missing `envVar` and remediation exactly. Do not suggest restart/retry loops.
   - `binding_required`: show `suggestions` when present; otherwise show candidate ids from `context.candidates` when present. The user should equip one engine that fills the missing binding, then retry the original package.
   - `user_cancelled`: stop without retrying automatically.
7. Do not run `coral-cli expansion equip <package>` a second time unless the user has changed the missing setup state or equipped a required peer engine.

### `--update <package>`

1. Bash(`coral-cli expansion update <package>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status               | Action |
|----------------------|--------|
| `already_up_to_date` | Inform user with version. If `command` is present for an install-only expansion, show the installed path; no further action |
| `updated`            | Show method and version. If `command` is present for an install-only expansion, show the installed path |
| `equipped`           | Expansion is updated and active in the coordinator |
| `catching_up`        | Expansion is updated and activating; tell the user to poll `/equip --list` until it reaches `equipped` |
| `already_equipped`   | Inform the user the updated expansion is already active |
| `error`              | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

4. `update` is equivalent to `equip` when the local version differs from the catalog version; `/equip <package>` also updates implicitly. Use `/equip --update <package>` when the user is explicitly asking to bump or refresh the installed version.

### `info <package>`

1. Bash(`coral-cli expansion info <package>`)
2. Parse the single-line JSON result.
3. Show the status and, when returned, the package `tier`, `provides.capabilities`, `addonPath`, installed `command`, retired-residue `cleanupCommand`, `userMessage`, and `remediation`. Treat an error result as terminal.

### `uninstall <equipment-name>`

1. Bash(`coral-cli expansion unequip <equipment-name>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status         | Action                                                                                                           |
|----------------|------------------------------------------------------------------------------------------------------------------|
| `uninstalled`  | Confirm the installed-tier engine was removed through the coordinator-owned catalog-removal transaction           |
| `not_equipped` | Inform user the engine was already not equipped; treat as success                                                |
| `error`        | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

4. `unequip` for installed-tier engines asks the coordinator to remove the catalog entry transactionally, which disposes any live scope without running bundled fallback, unregisters manifest-scoped capability declarations when allowed, and then removes local artifacts. For install-only packages, it removes the local binary.

## Notes

- Install-only binaries and engine artifacts both land under the engine data tree (`~/.coral/data/engines/<engine>/`, or `~/.coral/data-dev/engines/<engine>/` when `CORAL_FLAVOR=dev`); the CLI reports the exact installed path as `command`
- Corpus indexes stay under `~/.coral/data/kb/` in prod or `~/.coral/data-dev/kb/` in dev
- These data paths are account-neutral. `CODEX_HOME` and `CLAUDE_CONFIG_DIR` select provider credentials per invocation and never change the Coral daemon or state root
- Some installed engines may have native artifacts or model downloads; follow the `userMessage` and `remediation` returned by the CLI for missing prerequisites.
- An install-only package (`activation: 'none'`) installs by running the package's own install script (which Coral executes via the shell, e.g. `curl … | bash`). That external script — not Coral — may register the tool with the coding agent (for example as an MCP server); when it does, the agent must be restarted before the newly installed tooling is available.
- On Windows, `unequip` after activation may require a Coral restart when a loaded native addon remains mapped for the coordinator process lifetime.
