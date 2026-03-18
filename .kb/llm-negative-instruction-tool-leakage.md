# LLM Negative Instructions Leak Forbidden Alternatives

## Rule
Never tell an LLM "don't use tool X" in agent protocols. Mentioning a forbidden alternative informs the LLM of its existence and creates shortcut temptation. Instead, only describe the correct approach — omit all references to the forbidden path.

## Why
LLMs treat "don't do X" as "X exists and is an option, but you shouldn't use it." Under cognitive load or when the shortcut seems rational (e.g., "the proxy just wraps this tool anyway"), the LLM bypasses the prohibition. The negative instruction backfires because it provides the very information needed to take the shortcut.

## Pattern
```markdown
# Wrong — draws attention to the forbidden alternative
**IMPORTANT**: Do NOT call codex MCP tools directly. Direct MCP tool calls
are NEVER a substitute for spawning reviewer agents.
# ^ LLM now knows: "there's a codex MCP tool I could call directly"

# Right — only describe the correct path
**IMPORTANT**: All reviewers MUST be spawned as subagents via the Task tool.
# ^ LLM has no reason to consider alternatives
```

Corollary: if other skills in the same codebase DO instruct direct tool calls (e.g., `/ralph --codex` says "call Codex directly"), those instructions can bleed into the LLM's prior even when a different skill is active. Minimize cross-contamination by keeping protocol instructions self-contained and avoiding references to other skills' patterns.
