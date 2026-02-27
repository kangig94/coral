# Hook Context Injection — Only SessionStart and UserPromptSubmit

## Rule
Only `SessionStart` and `UserPromptSubmit` hook events can inject content into Claude's context (via `additionalContext` in stdout or plain stdout). Other events like `PreCompact` have stdout that is displayed to the user but not seen by Claude. `systemMessage` is also user-facing only.

## Why
If a hook writes to stdout in an unsupported event (e.g., PreCompact), the output appears in the terminal but Claude never receives it, silently failing. This caused `kb-promote-reminder.mjs` to not work when triggered from PreCompact — it had to be moved to a SessionStart hook with a compact matcher.

## Pattern
```
# Wrong: PreCompact hook trying to inject context
// hooks.json: { "event": "PreCompact", ... }
// script writes to stdout → user sees it, Claude does not

# Right: SessionStart hook with compact matcher
// hooks.json: { "event": "UserPromptSubmit", ... }  or  { "event": "SessionStart", ... }
// stdout → Claude receives as additionalContext
```
