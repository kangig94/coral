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
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-codex-[0-9a-f]{12}-cache\.json$`
   - regular files in `CONFIG_DIR/hud` whose basename matches exactly `^\.coral-codex-[0-9a-f]{12}\.lock$`
   Do not follow symlinks or delete any broader `.coral-*` pattern.
4. Confirm removal to the user

---

## HUD Script

The HUD script source is `coral-hud.mjs` in this directory.
The install command reads this file and writes it to `CONFIG_DIR/hud/coral-hud.mjs`.

## Notes

- `CONFIG_DIR` is the Claude config dir from the SessionStart context (see Config directory above); each config dir keeps its own HUD install and its own Codex opt-in flag
- If re-running install, overwrite the existing script (this updates the HUD to the latest version)
- Claude rate limits are fetched from `api.anthropic.com/api/oauth/usage` using OAuth credentials
- Enterprise/extra-usage plans have no 5h/weekly windows; instead the usage API returns `extra_usage` (a monthly dollar cap), shown in the limits slot as `mo: <pct> ($used/$limit)`
- Codex limits, credits, and spend controls are fetched from `chatgpt.com/backend-api/wham/usage` (GET, no token cost); requires Codex login (`CODEX_DIR/auth.json`)
- Layout: Line 1 shows Claude model/limits/context/session/activity; Line 2 conditionally shows Codex model/limits/credits; Line 3 conditionally shows Coral backend state
- Skill detection reads the last 500KB of `transcript_path` JSONL and recognizes `Skill`/`proxy_Skill` tool-use blocks plus slash-command messages
- Both fetches run in parallel
- Claude API results are cached for 180 seconds on success, 30 seconds on error. HTTP 429 responses trigger exponential backoff from 2 minutes up to 10 minutes.
- On error, the HUD preserves last-known-good rate-limit data until the error cache expires. The error indicator is shown only when no stale data exists.
- Error indicators are explicit: `throttled: refreshes in Xm` for HTTP 429, `re-login required` for explicit 401/403 auth failures, and `API unavailable` for other fetch/refresh failures.
- Missing or unsupported credentials stay silent; `re-login required` appears only for observable auth failures.
- The session slot combines spend and duration when available, for example `$0.43 47m`.
- Codex opt-in is controlled by `CONFIG_DIR/hud/.coral-codex-enabled` flag file; managed during install
- If credentials are unavailable (e.g., API key users or Codex not installed), the respective rate limit section is silently omitted
