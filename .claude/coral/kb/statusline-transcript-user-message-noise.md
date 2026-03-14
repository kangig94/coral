# Statusline Transcript User Message Noise
Promoted: 2026-03-14

## Rule
When parsing the Claude Code transcript for the last user message, multiple system-generated entries appear as `type:"user"` and must be filtered: skill expansion prompts (`Base directory for this skill:`), command XML wrappers (`<command-message>`, `<command-name>`), hook feedback (`Stop hook feedback:`), context compaction summaries (`This session is being continued from`), task notifications (`<task-notification>`), and local command output (`<local-command-*>`). Command XML entries should be parsed to reconstruct the original user input (`/skill-name args`) rather than discarded.

## Why
Without filtering, the statusline shows expanded skill prompts, hook output, or XML fragments as the "last user input" instead of what the user actually typed. The skill expansion prompt replaces the original `/coral:ralph --codex ...` input entirely in the transcript — there is no separate entry preserving the raw user text.

## Pattern
Right — extract command name+args from XML, filter noise, collapse newlines:
```javascript
function extractUserText(raw) {
  const cmdMatch = raw.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmdMatch) {
    const name = cmdMatch[1].trim();
    const argsMatch = raw.match(/<command-args>([^<]*)<\/command-args>/);
    const args = argsMatch?.[1]?.trim();
    return args ? `${name} ${args}` : name;
  }
  if (/<task-notification>|<local-command|^Base directory for this skill:/i.test(raw)) return null;
  const clean = raw.replace(/<[^>]+>/g, "").trim();
  return clean || null;
}
// Always collapse newlines before display:
const lastMsg = transcript.lastUserMessage?.replace(/[\n\r]+/g, " ");
```

Wrong — strip all XML then show whatever remains (shows `coral:ralph /coral:ralph --codex...` with newlines):
```javascript
const clean = content.replace(/<[^>]+>/g, "").trim();
return clean; // multi-line, includes command-message inner text twice
```
