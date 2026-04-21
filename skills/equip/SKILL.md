---
name: equip
description: "One-touch install of Coral companion tooling and Needle KB runtime"
argument-hint: "[--list | [--update] <package> | uninstall <equipment-name>]"
---

# Equip

Install and configure Coral companion tooling for Claude Code.

## Execution

### No argument or `--list`

1. Bash(`node equip/install.mjs --list`)
2. Parse the single-line JSON result.
3. Present the catalog as a table with `id`, `name`, package `description`, `status`, and `statusDescription` when present.
4. Use the merged coordinator status for `needle` and map it as follows:

| status | Meaning |
|--------|---------|
| `equipped` | Active in the coordinator |
| `catching_up` | Registered and replaying the corpus |
| `inactive` | Installed but not registered. Run `/equip needle` to reactivate |
| `unavailable` | Binary missing. Run `/equip needle` to reinstall |
| `disabled_pending_reinstall` | Load failed. Run `/equip needle` to reinstall |
| `installing` | Another `/equip` is currently holding `install.lock` |
| `not_equipped` | Needle is not installed locally |

5. After coordinator restart, equipment is shown as `inactive` until you run `/equip <name>` again. Cursor state is preserved; re-equipping does not replay from scratch.
6. Ask the user which package to install.

### `<package>` (e.g. `needle`)

1. Bash(`node equip/install.mjs <package>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status | Action |
|--------|--------|
| `already_installed` | Inform user, then continue to Post-Install Routing if `postInstall` is present |
| `already_up_to_date` | Inform user with version, then continue to Post-Install Routing if `postInstall` is present |
| `installed` | Show method used, then continue to Post-Install Routing |
| `updated` | Show method and version, then continue to Post-Install Routing |
| `error` | Show `userMessage` + `remediation` when present, otherwise `message`. Show `suggestions` when present, then stop |

### `uninstall <equipment-name>`

1. Bash(`node equip/install.mjs uninstall <equipment-name>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status | Action |
|--------|--------|
| `uninstalled` | Confirm the equipment was removed and the slot reverted to its base implementation |
| `not_equipped` | Inform user the slot was already clear; treat as success |
| `error` | Show `userMessage` + `remediation` when present, otherwise `message`. Show `suggestions` when present, then stop |

4. `uninstall` is coordinator-routed. The coordinator resolves the live handle, drains with `handle.stop()`, then unregisters with `handle.unregister()` before cursor cleanup and storage deletion. If the equipment is installed but inactive, it skips the drain path and still clears durable ownership plus storage.

### Post-Install Routing

1. If `onboarding` is present, finish onboarding before any `postInstall` action runs:
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
     - Do not run `postInstall` until the user confirms the manual setup is complete.
2. If `postInstall` contains `register_equipment`:
   - Bash(`node equip/coordinator-client.mjs register needle`)
   - This routes to `coordinator.registerEquipment({ name: 'needle' })` via IPC.
   - Route the result:
     - `equipped`: inform the user that enhanced KB mode is active.
     - `catching_up`: inform the user that enhanced KB mode is activating and tell them to poll `/equip --list` until it reaches `equipped`.
     - `already_equipped`: inform the user that Needle is already active.
     - `error`: show `userMessage` + `remediation` when present, otherwise `message`, then stop.
3. Initial catchup is triggered inside the coordinator registration RPC. There is no separate `backend_shutdown` or `kb_reindex` action here.
4. If no `postInstall` action remains, inform the user `Installed.` and stop.

## Notes

- Binary installs go to `~/.claude/tools/`
- `needle` installs the native addon to `~/.coral/data/equipment/needle/coral-needle.node`
- Corpus indexes stay under `~/.coral/data/kb/`
- If a Needle prebuild is unavailable, the installer falls back to `cmake` and may install it via `uv tool install cmake`
- To remove Needle, run `/equip uninstall needle`
