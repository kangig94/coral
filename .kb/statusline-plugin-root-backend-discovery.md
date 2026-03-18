# Statusline Backend Discovery Must Follow CLAUDE_PLUGIN_ROOT
Promoted: 2026-03-14 | Updated: 2026-03-14
## Rule
Global statusline hooks must derive Coral backend discovery from `CLAUDE_PLUGIN_ROOT` instead of hardcoding `~/.claude/coral/backend.json`, and any auto-update path must only rewrite the installed hook copy rather than mutating a `--plugin-dir` development workspace. If backend discovery is disabled because `CLAUDE_PLUGIN_ROOT` is missing or cannot be canonicalized, the HUD must skip backend rendering before consulting any cached backend line so stale state cannot leak across installations.
## Why
`coral-hud.mjs` runs as a global Claude Code hook from `~/.claude/hud/`, while Coral installations can be namespaced and launched from different plugin roots. A hardcoded backend path crosses installation boundaries and shows the wrong daemon state for non-default installs. Even after switching to plugin-root-aware discovery, checking the cache before the discovery guard can still resurrect a stale backend line when the plugin root is absent or invalid. The updater has the opposite risk: if it rewrites the source workspace instead of the installed hook copy, global statusline behavior drifts away from the plugin the user is actually running.
## Pattern
Right:
```javascript
const backendPath = resolveBackendInfoPath();
if (!backendPath) return null;
const cached = readBackendSlot();

if (targetPath.startsWith(hudInstallDir)) {
  writeFileSync(targetPath, renderedHud);
}
```

Wrong:
```javascript
const cached = readBackendSlot();
const backendPath = join(homedir(), ".claude/coral/backend.json");
writeFileSync(devWorkspaceHudPath, renderedHud);
```
