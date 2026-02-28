# Codex Proxy — Reference, Don't Duplicate

## Rule

`agents/codex-proxy.md` is a thin proxy that reads Claude-native agent files (`agents/<role>.md`) at runtime and passes their `<Agent_Prompt>` content to Codex CLI. It does NOT maintain its own prompt templates — the original agent definitions are the single source of truth. Ralph is the sole exception (inline template, no agent file).

## Why

**Single source of truth**: Earlier codex-proxy embedded simplified prompt templates (~15 lines each) that captured only 10-15% of the original agent methodology (Investigation_Protocol, Output_Format, Success_Criteria were all lost). When agent definitions improved, the codex-proxy templates drifted. Reading the originals at runtime eliminates this class of bugs entirely.

**Richer Codex prompts**: Codex now receives the full methodology (investigation protocols, output formats, failure modes, examples) instead of bare-bones `[SYSTEM]` stubs. Claude-specific sections (Tool_Usage, disallowedTools) are harmlessly ignored by Codex.

**Prompt caching**: Still works — parallel spawns (architect + critic) share the same `codex-proxy.md` system prompt prefix. The agent file content differs per role, but that's in the user message (Codex prompt), not the system prompt.

## Pattern

```
# CORRECT: Proxy reads agent files at runtime
agents/codex-proxy.md          # thin proxy — routing + infrastructure only
  tools: Read, Glob, mcp__plugin_coral_cx__codex
  Role: architect → Glob + Read agents/architect.md → pass to Codex
  Role: critic    → Glob + Read agents/critic.md    → pass to Codex

# WRONG: Proxy embeds duplicated templates
agents/codex-proxy.md          # 300+ lines with simplified copies of each role
  Role: architect → use internal 29-line template (drifts from 112-line original)
```

**Role-routing guarantee**: Callers always supply `Role: <name>` explicitly. Missing role → explicit error (no inference).

**Hook compatibility**: The `(^|:)codex-` regex in `hooks/hooks.json` matches `codex-proxy` without any change.
