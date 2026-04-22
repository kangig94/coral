---
name: equip
description: One-touch install of Coral companion tooling and Needle KB runtime
argument-hint: "[--list | [--update] <package> | uninstall <equipment-name>]"
---

# Equip

Install and configure Coral companion tooling for Claude Code.

## Verb Mapping

- `/equip <pkg>` -> `coral-cli expansion equip <pkg>`
- `/equip --list` -> `coral-cli expansion list`
- `/equip --update <pkg>` -> `coral-cli expansion update <pkg>`
- `/equip uninstall <pkg>` -> `coral-cli expansion unequip <pkg>`
- If this surface exposes it, `/equip info <pkg>` -> `coral-cli expansion info <pkg>`

## Execution

### No argument or `--list`

1. Bash(`coral-cli expansion list`)
2. Parse the single-line JSON result.
3. Route read responses by top-level `status`:

| status    | Action |
|-----------|--------|
| `catalog` | Present the catalog as a table with `id`, `name`, package `description`, translated `activation`, `status`, and `statusDescription` when present |
| `info`    | Show the single package entry using the same package-status routing table below and the same translated `activation` label |
| `error`   | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

4. For each catalog entry, route inner `status` as follows:

| status                       | Meaning                                                         |
|------------------------------|-----------------------------------------------------------------|
| `equipped`                   | Active in the coordinator                                       |
| `catching_up`                | Registered and replaying the corpus                             |
| `inactive`                   | Installed but not registered. Run `/equip needle` to reactivate |
| `unavailable`                | Binary missing or coordinator unreachable. Run `/equip needle` to reinstall |
| `disabled_pending_reinstall` | Load failed. Run `/equip needle` to reinstall                   |
| `installing`                 | Another `/equip` is currently holding `install.lock`            |
| `not_equipped`               | Needle is not installed locally                                 |
| `not_installed`              | Install-only expansion (e.g. `cgc`) is not installed locally    |
| `installed`                  | Install-only expansion is installed locally and ready to use    |

5. When rendering `activation`, translate internally:
   - `activation: 'equipment'` -> `Active in Coordinator`
   - `activation: 'none'` -> `Install-only (use directly via the installed path)`
6. After coordinator restart, equipment is shown as `inactive` until you run `/equip <name>` again. Cursor state is preserved; re-equipping does not replay from scratch.
7. Ask the user which package to install.

### `<package>` (e.g. `needle`, `cgc`)

1. Bash(`coral-cli expansion equip <package>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status               | Action                                                                                                           |
|----------------------|------------------------------------------------------------------------------------------------------------------|
| `already_installed`  | Inform user, then continue to Post-Install Routing if `onboarding` is present                                    |
| `already_up_to_date` | Inform user with version, then continue to Post-Install Routing if `onboarding` is present                       |
| `installed`          | Show method used. If `onboarding` is present, continue to Post-Install Routing; otherwise `expansion equip` has already activated if applicable |
| `updated`            | Show method and version. Same routing as `installed`                                                             |
| `equipped`           | Expansion is installed and active in the coordinator (equipment-backed packages only)                            |
| `catching_up`        | Expansion is activating; tell the user to poll `/equip --list` until it reaches `equipped`                       |
| `already_equipped`   | Inform the user the expansion is already active                                                                  |
| `error`              | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

4. For install-only expansions (e.g. `cgc`), if the result includes `command`, show the installed binary path so the user knows how to invoke it, for example `cgc installed at /path/to/cgc`.

### `--update <package>`

1. Bash(`coral-cli expansion update <package>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status               | Action |
|----------------------|--------|
| `already_up_to_date` | Inform user with version. If `command` is present for an install-only expansion, show the installed path; no further action |
| `updated`            | Show method and version. If `command` is present for an install-only expansion, show the installed path. If `onboarding` is present, continue to Post-Install Routing |
| `equipped`           | Expansion is updated and active in the coordinator |
| `catching_up`        | Expansion is updated and activating; tell the user to poll `/equip --list` until it reaches `equipped` |
| `already_equipped`   | Inform the user the updated expansion is already active |
| `error`              | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

4. `update` is equivalent to `equip` when the local version differs from the catalog version; `/equip <package>` also updates implicitly. Use `/equip --update <package>` when the user is explicitly asking to bump or refresh the installed version.

### `uninstall <equipment-name>`

1. Bash(`coral-cli expansion unequip <equipment-name>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status         | Action                                                                                                           |
|----------------|------------------------------------------------------------------------------------------------------------------|
| `uninstalled`  | Confirm the expansion was removed and the slot reverted to its base implementation                               |
| `not_equipped` | Inform user the slot was already clear; treat as success                                                         |
| `error`        | Show `userMessage` and `remediation`. Show `suggestions` when present, then stop. For debugging, show `code` and any `context` fields |

4. `unequip` for equipment-backed expansions (e.g. `needle`) drains the live consumer, unregisters it, deletes the cursor row and local artifacts, and restores the base implementation. For install-only expansions (e.g. `cgc`), it simply removes the local binary.

### Post-Install Routing

1. If `onboarding` is present on the install/update result, finish onboarding before running `coral-cli expansion equip <package>` a second time:
   - Read `process.env`, then read `~/.coral/.env` if present.
   - Inspect `onboarding.requiredEnv`. It is provider-aware: match the chosen provider against `requiredEnv[].provider`; if there is no exact match, use the `default` entry.
   - `local-onnx` is satisfied by `CORAL_EMBEDDING_PROVIDER=local-onnx` and `CORAL_EMBEDDING_MODEL=<model>`. Do not require `CORAL_EMBEDDING_API_KEY`.
   - `gemini` and other remote providers are satisfied by `CORAL_EMBEDDING_PROVIDER=<provider>` and `CORAL_EMBEDDING_API_KEY`.
   - If the chosen provider's required values are already present from either source, skip onboarding.
   - If the chosen provider is missing or any required value is missing, offer exactly these choices:
     - Local: `nomic-embed-text` (768d)
     - Local: `bge-m3` (1024d)
     - Manual setup
   - If the user chooses a local model:
     - Ensure `onboarding.localRuntime.targetDir` exists.
     - If `package.json` is absent there, create a minimal npm root such as `{"name":"kb-runtime","private":true}`.
     - Run `npm install onnxruntime-node` in `onboarding.localRuntime.targetDir`.
     - Write `CORAL_EMBEDDING_PROVIDER=local-onnx` and `CORAL_EMBEDDING_MODEL=<chosen model>` to `~/.coral/.env`. Do not write an API key.
     - Show the security notice: "Store CORAL_EMBEDDING_API_KEY in ~/.coral/.env directly, NOT in settings.json."
   - If the user chooses manual setup:
     - Tell them to edit `~/.coral/.env` directly and add the embedding settings there.
     - Show the security notice: "Store CORAL_EMBEDDING_API_KEY in ~/.coral/.env directly, NOT in settings.json."
     - Do not re-invoke `coral-cli expansion equip` until the user confirms the manual setup is complete.
2. After onboarding completes, re-invoke Bash(`coral-cli expansion equip <package>`) to trigger coordinator activation. The workflow is unified — a single `coral-cli expansion equip <package>` performs install + activate in one call, with the onboarding pause being the only reason the first call returns before activation.
3. If no `onboarding` is present, `coral-cli expansion equip` already performed activation (for equipment-backed expansions) or install (for install-only expansions) — no second call is needed.
4. Initial catchup is triggered inside the coordinator registration RPC. There is no separate `backend_shutdown` or `kb_reindex` action here.
5. If the result status is `installed` or `updated` for install-only expansions (e.g. `cgc`), tell the user it is install-only and show `command` when present, for example `cgc installed at /path/to/cgc`, then stop.

## Notes

- Binary installs go to `~/.claude/tools/`
- `needle` installs the native addon to `~/.coral/data/equipment/needle/coral-needle.node` (production flavor) or `~/.coral/data-dev/equipment/needle/coral-needle.node` (dev flavor, when `CORAL_FLAVOR=dev` is set)
- Corpus indexes stay under `~/.coral/data/kb/`
- If a Needle prebuild is unavailable, the installer falls back to `cmake` and may install it via `uv tool install cmake`
- To remove Needle, run `/equip uninstall needle`
- On Windows, `unequip` after activation may require a Coral restart because the Node.js N-API loader keeps loaded `.node` addons mapped for the coordinator process lifetime. The `rmSync` call retries briefly but cannot unmap a running addon.
