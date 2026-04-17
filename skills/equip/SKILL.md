---
name: equip
description: "One-touch install of Coral companion tooling and KB runtime"
argument-hint: "[--list | [--update] cgc[@version] | kb[@version]]"
---

# Equip

Install and configure Coral companion tooling for Claude Code.

## Execution

### No argument or `--list`

1. Bash(`node equip/install.mjs --list`)
2. Present catalog as a table (id, name, description)
3. Ask the user which package to install

### `<package>` (e.g., `cgc` or `kb`)

1. Bash(`node equip/install.mjs <package>`)
2. Parse JSON output (single line from stdout)
3. Route by `status`:

| status | Action |
|--------|--------|
| `already_installed` | Inform user, continue to Post-Install Routing |
| `already_up_to_date` | Inform user (version shown). If `onboarding` or `postInstall` is present, continue to Post-Install Routing; otherwise done |
| `installed` | Show method used, continue to Post-Install Routing |
| `updated` | Show method and version, continue to Post-Install Routing |
| `error` | Show `message` and `suggestions`, stop |

### Post-Install Routing

1. If `onboarding` field present, finish onboarding before any `postInstall` action runs:
   - Read `process.env`, then read `~/.coral/.env` if present. Treat `CORAL_EMBEDDING_PROVIDER` and `CORAL_EMBEDDING_API_KEY` as satisfied if either source provides them.
   - If both values are already present, skip onboarding.
   - If either value is missing, offer exactly these choices:
     - Local: `nomic-embed-text` (768d)
     - Local: `bge-m3` (1024d)
     - Manual setup
   - If the user chooses a local model:
     - Ensure `onboarding.localRuntime.targetDir` exists.
     - If `package.json` is absent there, create a minimal npm root such as `{"name":"kb-runtime","private":true}`.
     - Run `npm install onnxruntime-node` in `onboarding.localRuntime.targetDir` before any reindex step.
     - Write `CORAL_EMBEDDING_PROVIDER=local-onnx` and `CORAL_EMBEDDING_MODEL=<chosen model>` to `~/.coral/.env`. Do not write an API key.
     - Show the security notice: "API key는 ~/.coral/.env에 직접 기록하세요. settings.json이 아닌 ~/.coral/.env에."
   - If the user chooses manual setup:
     - Tell them to edit `~/.coral/.env` directly and add the embedding settings there.
     - Show the security notice: "API key는 ~/.coral/.env에 직접 기록하세요. settings.json이 아닌 ~/.coral/.env에."
     - Do not run `postInstall` until the user confirms the manual setup is complete.
2. If `postInstall` field present → execute each action in order:
   - `backend_shutdown`: run `coral-cli backend shutdown`. Continue on success or not-running / connection-refused.
   - `kb_reindex`: run `coral-cli kb reindex --output-format json`.
   - Inform user: "Enhanced KB mode activated."
3. If neither → inform user "Installed.", done

No settings registration step exists here. The installer returns executable paths and runtime metadata only.

## Notes

- Binary installs go to `~/.claude/tools/`
- `kb` installs the native addon to `~/.coral/data/kb/vec/coral-vec.node`
- If a KB prebuild is unavailable, the installer falls back to `cmake` and may install it via `uv tool install cmake`
- To force reinstall, delete the installed artifact and run again. For `kb`, remove `~/.coral/data/kb/vec/coral-vec.node`
