# Claude CLI --resume does NOT preserve system prompt

## Rule
`claude -p --resume <id>` restores conversation history (user/assistant turns) but does NOT
restore the `--append-system-prompt` from the original invocation. System prompt is
invocation-scoped, not session-scoped. Must re-inject on every resume call.

## Why
Without re-injection, an agent that was "Coral Architect" in the first turn becomes
"main Claude Code agent" on resume — losing its persona, constraints, and role definition.

## Pattern
```typescript
// CORRECT: re-inject system prompt on resume
function appendSharedArgs(args, options) {
  if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt);
}
// Used by BOTH executeClaudeOneShot and executeClaudeResume

// WRONG: only inject system prompt on first call
// resume would lose the agent persona
```
