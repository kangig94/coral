# Hooks vs Statusline Data Asymmetry

Promoted: 2026-03-16 | Updated: 2026-03-16

## Rule

Hook event payloads and statusline input have different data available. Statusline receives `context_window` (with `used_percentage`, token counts) and `session_id` via stdin, but hooks only get `session_id`, `transcript_path`, `cwd`, `permission_mode`, and event-specific fields — no context metrics. To share data between them, use `~/.claude/hud/.coral-sessions.json` as a shared session state file keyed by `session_id`.

## Why

Without this knowledge, you might assume hooks can access context window data directly (they can't), or try to parse the transcript for token info (unreliable). The shared file pattern was designed to bridge this gap — statusline writes ctx% on each render, hooks read it.

## Pattern

Right — statusline writes, hook reads via shared file:
```javascript
// In statusline (coral-hud.mjs) — writer
writeSession(sessionId, { ctx, prompt, activity, agents, transcriptSize });

// In hook (ralph-loop.mjs) — reader
const sessionsPath = join(homedir(), '.claude', 'hud', '.coral-sessions.json');
const entry = JSON.parse(readFileSync(sessionsPath, 'utf8'))[sessionId];
```

Wrong — assuming hook has context data:
```javascript
// Hook does NOT receive this
const pct = input.context_window.used_percentage; // undefined
```
