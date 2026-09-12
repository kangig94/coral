---
name: statusline
description: Install or remove coral HUD statusline
argument-hint: "[install|uninstall]"
disable-model-invocation: true
---

# Coral Statusline

Manage the coral HUD statusline for Claude Code.

## Commands

> **Config directories**: `CONFIG_DIR` = the **Claude config dir** reported in the SessionStart context. `CODEX_DIR` = absolute `CODEX_HOME` when set, otherwise `~/.codex`. Use each directory consistently for its provider.

### install

1. Check if `CONFIG_DIR/hud/coral-hud.mjs` already exists:
   - If exists and content matches `coral-hud.mjs` in this skill directory: inform user "HUD is already up to date", skip to step 6
   - If exists with different content: inform user "Updating HUD script to latest version", proceed
   - If not exists: proceed
2. Read `coral-hud.mjs` from this skill directory and write it to `CONFIG_DIR/hud/coral-hud.mjs` (create `CONFIG_DIR/hud/` directory if needed)
3. Read `CONFIG_DIR/settings.json` (create if absent)
4. If `statusLine` already exists and is NOT coral's, **ask the user** before overwriting
5. Set `statusLine` to:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node CONFIG_DIR/hud/coral-hud.mjs"
     }
   }
   ```
   Expand `CONFIG_DIR` to its absolute path (and `~` to the real home directory).
6. Check if `CODEX_DIR/auth.json` exists:
   - If yes, ask the user: "Codex login detected. Display Codex usage in statusline?"
     - **yes** → create `CONFIG_DIR/hud/.coral-codex-enabled` (empty file — the **same** `CONFIG_DIR/hud` as step 2; do not write this to `~/.claude` when `CONFIG_DIR` differs)
     - **no** → delete `CONFIG_DIR/hud/.coral-codex-enabled` if it exists
   - If no `auth.json`, skip silently (do not create or delete any Codex files)
7. Confirm installation to the user

### uninstall

1. Read `CONFIG_DIR/settings.json`
2. Remove the `statusLine` key
3. Delete the following files if they exist:
   - `CONFIG_DIR/hud/coral-hud.mjs`
   - `CONFIG_DIR/hud/.coral-cache.json`
   - `CONFIG_DIR/hud/.coral-codex-enabled`
   - `CONFIG_DIR/hud/.coral-git-cache.json`
   - `CONFIG_DIR/hud/.coral-git.lock`
   - `CONFIG_DIR/hud/.coral-sessions.json`
   - `CONFIG_DIR/hud/.coral-backend-cache.json`
   - `CONFIG_DIR/hud/.coral-claude.lock`
   - `CONFIG_DIR/hud/.coral-backend.lock`
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-cache\.json\.tmp-[0-9]+$`
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-git-cache\.json\.tmp-[0-9]+$`
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-sessions\.json\.tmp-[0-9]+$`
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-backend-cache\.json\.tmp-[0-9]+$`
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-codex-[0-9a-f]{12}-cache\.json\.tmp-[0-9]+$`
   - regular files in `CODEX_DIR` whose basename matches exactly `^auth\.json\.tmp-[0-9]+$`
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-codex-[0-9a-f]{12}-cache\.json$`
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-codex-[0-9a-f]{12}\.lock$`
   Do not follow symlinks or delete any broader `.coral-*` pattern.
4. Confirm removal to the user

---

## HUD Script

The HUD script source is `coral-hud.mjs` in this directory.
The install command reads this file and writes it to `CONFIG_DIR/hud/coral-hud.mjs`.

## Notes

- `CONFIG_DIR` is the Claude config dir from the SessionStart context (see Config directory above); each config dir keeps its own HUD install, its own Codex opt-in flag, and its own runtime files
- If re-running install, overwrite the existing script (this updates the HUD to the latest version)
- Step 3 lists every path the script can create, plus one an older build could have stranded
  (`CODEX_DIR/auth.json.tmp-<pid>`, which held credentials). Adding a path the script writes without
  adding it there leaves a file behind on an uninstalled machine.
- Nothing else about how the script behaves belongs in this file. It installs the script and removes
  it; a second description of the script's runtime would be wrong the first time the script changed,
  and nothing here would fail to say so.
