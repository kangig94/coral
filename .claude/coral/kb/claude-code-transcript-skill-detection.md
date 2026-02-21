# Claude Code Transcript JSONL — Skill Detection

## Rule
There are **two** places skills appear in the Claude Code transcript JSONL. (1) **User-typed slash commands** (`/coral:analyze`) are recorded as **user messages** where `entry.message.content` is a plain string containing `<command-message>skill-name</command-message>` XML tags. (2) **Claude-invoked Skill tool calls** (e.g. ralph internally calling `/commit`) are recorded as **assistant messages** with `entry.message.content[]` as an array containing a `tool_use` block with `name === "Skill"` or `name === "proxy_Skill"`. To find the last active skill, check for both patterns in a single backward scan — whichever appears most recently wins.

## Why
User-typed slash commands and Claude-invoked Skill calls produce structurally different transcript entries. Searching only for `tool_use` blocks misses all user slash commands (which is the primary use case). Searching only for `<command-message>` misses programmatic skill invocations from agentic workflows. Both must be handled in a single backward scan to always return the most recently used skill regardless of invocation path.

## Pattern

**Pattern A — user slash command** (in user message, content is a string):
```json
{"message":{"role":"user","content":"<command-message>coral:analyze</command-message>\n<command-name>/coral:analyze</command-name>\n<command-args>...</command-args>"}}
```

**Pattern B — Claude-invoked Skill** (in assistant message, content is an array):
```json
{"message":{"role":"assistant","content":[{"type":"tool_use","name":"Skill","input":{"skill":"coral:ralph","args":"..."}}]}}
```

**Right** — check both in one backward scan:
```javascript
for (let i = lines.length - 1; i >= 0; i--) {
  const line = lines[i];
  // Pattern A: user slash command
  if (line.includes("command-message")) {
    try {
      const entry = JSON.parse(line);
      const content = entry?.message?.content;
      if (typeof content === "string") {
        const m = content.match(/<command-message>([^<]+)<\/command-message>/);
        if (m?.[1]) return m[1];
      }
    } catch {}
  }
  // Pattern B: Claude-invoked Skill tool_use
  if (line.includes('"tool_use"') && (line.includes('"Skill"') || line.includes('"proxy_Skill"'))) {
    try {
      const entry = JSON.parse(line);
      const blocks = entry?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j];
        if (block.type === "tool_use"
            && (block.name === "Skill" || block.name === "proxy_Skill")
            && block.input?.skill) {
          return block.input.skill;
        }
      }
    } catch {}
  }
}
```

**Stdin field**: `transcript_path` is available in Claude Code statusline stdin (verified from `ref/oh-my-claudecode/src/hud/types.ts`). Older Claude Code versions may not include it — always null-check.

**Required fs imports**: `openSync, fstatSync, readSync, closeSync` from `"fs"`.
