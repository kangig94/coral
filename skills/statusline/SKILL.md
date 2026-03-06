---
name: statusline
description: Install or remove coral HUD statusline
argument-hint: "[install|uninstall]"
disable-model-invocation: true
---

# Coral Statusline

Manage the coral HUD statusline for Claude Code.

## Commands

### install

1. Check if `~/.claude/hud/coral-hud.mjs` already exists:
   - If exists and content matches `coral-hud.mjs` in this skill directory: inform user "HUD is already up to date", skip to step 6
   - If exists with different content: inform user "Updating HUD script to latest version", proceed
   - If not exists: proceed
2. Read `coral-hud.mjs` from this skill directory and write it to `~/.claude/hud/coral-hud.mjs` (create `~/.claude/hud/` directory if needed)
3. Read `~/.claude/settings.json` (create if absent)
4. If `statusLine` already exists and is NOT coral's, **ask the user** before overwriting
5. Set `statusLine` to:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node ~/.claude/hud/coral-hud.mjs"
     }
   }
   ```
   Replace `~` with the actual home directory path.
6. Check if `~/.codex/auth.json` exists:
   - If yes, ask the user: "Codex login detected. Display Codex usage in statusline?"
     - **yes** → create `~/.claude/hud/.coral-codex-enabled` (empty file)
     - **no** → delete `~/.claude/hud/.coral-codex-enabled` and `~/.claude/hud/.coral-codex-usage-cache.json` if they exist
   - If no `auth.json`, skip silently (do not create or delete any Codex files)
7. Confirm installation to the user

### uninstall

1. Read `~/.claude/settings.json`
2. Remove the `statusLine` key
3. Delete the following files if they exist:
   - `~/.claude/hud/coral-hud.mjs`
   - `~/.claude/hud/.coral-usage-cache.json`
   - `~/.claude/hud/.coral-codex-usage-cache.json`
   - `~/.claude/hud/.coral-codex-enabled`
4. Confirm removal to the user

---

## HUD Script

The HUD script source is `coral-hud.mjs` in this directory.
The install command reads this file and writes it to `~/.claude/hud/coral-hud.mjs`.

## Notes

- `~` must be expanded to the real home directory in both the file path and settings.json command
- If re-running install, overwrite the existing script (this updates the HUD to the latest version)
- Claude rate limits are fetched from `api.anthropic.com/api/oauth/usage` using OAuth credentials
- Codex rate limits and spark limits are fetched from `chatgpt.com/backend-api/wham/usage` (GET, no token cost); requires Codex login (`~/.codex/auth.json`)
- Two-line layout: Line 1 (Claude) shows model, limits, ctx, session, and last active skill; Line 2 (Codex) shows codex model, codex limits, and spark limits
- Skill detection reads last 500KB of `transcript_path` JSONL (tail-read for performance), finds last `Skill` or `proxy_Skill` tool_use block
- Both fetches run in parallel
- Claude API results are cached for 180 seconds on success, 30 seconds on error. HTTP 429 responses trigger exponential backoff from 2 minutes up to 10 minutes.
- On error or rate-limit, the respective section is silently omitted and skipped for the duration of the cache/backoff window.
- Codex opt-in is controlled by `~/.claude/hud/.coral-codex-enabled` flag file; managed during install
- If credentials are unavailable (e.g., API key users or Codex not installed), the respective rate limit section is silently omitted
