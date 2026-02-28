# Hook Context Injection — Plain stdout vs `hookSpecificOutput`

## Rule
For `PreCompact`, plain stdout is user-visible only and not injected into Claude's context. That lesson still stands. Separately, tool events such as `PostToolUse` and `PostToolUseFailure` can inject context through structured JSON output (`hookSpecificOutput.additionalContext` on exit 0). Plain/raw stdout and structured `hookSpecificOutput` are different mechanisms.

## Why
If a hook writes only plain stdout in an unsupported event (e.g., `PreCompact`), the text appears in the terminal but Claude never receives it, causing silent failures. This caused `kb-promote-reminder.mjs` to fail when triggered from `PreCompact` and required moving it to `SessionStart` with a `compact` matcher. Tool hooks avoid this by returning structured JSON in `hookSpecificOutput`.

## Pattern
```
# Wrong: PreCompact hook trying to inject context via plain stdout
// hooks.json: { "event": "PreCompact", ... }
// script writes to stdout → user sees it, Claude does not

# Right (plain stdout path): SessionStart/UserPromptSubmit context injection
// hooks.json: { "event": "UserPromptSubmit", ... } or { "event": "SessionStart", ... }
// stdout → Claude receives context

# Right (tool event path): PostToolUse/PostToolUseFailure via hookSpecificOutput
// hooks.json: { "event": "PostToolUseFailure", ... }
// script outputs JSON with hookSpecificOutput.additionalContext → Claude receives context
```
