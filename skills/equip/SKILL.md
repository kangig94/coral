---
name: equip
description: "One-touch install of Coral companion tooling and Needle KB runtime"
argument-hint: "[--list | [--update] needle[@version] | uninstall <name>]"
---

# Equip

Install and configure Coral companion tooling for Claude Code.

## Execution

### No argument or `--list`

1. Bash(`node equip/install.mjs --list`)
2. Parse the single-line JSON result.
3. Present the catalog as a table with `id`, `name`, `description`, and `status` when present.
4. Use the merged coordinator status for `needle`: `equipped`, `catching_up`, `inactive`, `installing`, `not_equipped`, `disabled_pending_reinstall`, or `unavailable`.
5. Ask the user which package to install.

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
| `error` | Show `userMessage` + `remediation` when present, otherwise `message`, then stop |

### `uninstall <package>`

1. Bash(`node equip/install.mjs uninstall <package>`)
2. Parse the single-line JSON result.
3. Route by `status`:

| status | Action |
|--------|--------|
| `uninstalled` | Confirm the equipment was removed and the slot reverted to its base implementation |
| `not_equipped` | Inform user the slot was already clear; treat as success |
| `error` | Show `userMessage` + `remediation` when present, otherwise `message`, then stop |

4. `uninstall` is coordinator-routed. The coordinator resolves the live handle, drains with `handle.stop()`, then unregisters with `handle.unregister()` before cursor cleanup and storage deletion. If the equipment is installed but inactive, it skips the drain path and still clears durable ownership plus storage.

### Post-Install Routing

1. If `onboarding` is present, finish onboarding before any `postInstall` action runs:
   - Read `process.env`, then read `~/.coral/.env` if present. Treat `CORAL_EMBEDDING_PROVIDER` and `CORAL_EMBEDDING_API_KEY` as satisfied if either source provides them.
   - If both values are already present, skip onboarding.
   - If either value is missing, offer exactly these choices:
     - Local: `nomic-embed-text` (768d)
     - Local: `bge-m3` (1024d)
     - Manual setup
   - If the user chooses a local model:
     - Ensure `onboarding.localRuntime.targetDir` exists.
     - If `package.json` is absent there, create a minimal npm root such as `{"name":"kb-runtime","private":true}`.
     - Run `npm install onnxruntime-node` in `onboarding.localRuntime.targetDir`.
     - Write `CORAL_EMBEDDING_PROVIDER=local-onnx` and `CORAL_EMBEDDING_MODEL=<chosen model>` to `~/.coral/.env`. Do not write an API key.
     - Show the security notice: "API key는 ~/.coral/.env에 직접 기록하세요. settings.json이 아닌 ~/.coral/.env에."
   - If the user chooses manual setup:
     - Tell them to edit `~/.coral/.env` directly and add the embedding settings there.
     - Show the security notice: "API key는 ~/.coral/.env에 직접 기록하세요. settings.json이 아닌 ~/.coral/.env에."
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
