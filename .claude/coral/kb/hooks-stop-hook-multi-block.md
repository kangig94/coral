# Multiple Stop Hooks Can Each Block Independently

## Rule
Multiple Stop hooks can each return `{ decision: "block", reason: "..." }` in the same stop event without conflict. Each blocking hook's `reason` is delivered to Claude as a separate user prompt injection — they do not interfere with each other and both fire successfully.

## Why
Designing a new Stop hook alongside an existing one might seem to require coordination or merging. It does not. The hooks are independent: each reads its own state (flag file, state file), makes its own decision, and returns its own block reason. Claude receives each reason as if the user had sent separate messages.

## Pattern
```
# RIGHT: Two independent Stop hooks, both block
hooks/kb-promote-reminder.mjs → { decision: "block", reason: "Review memos for KB promotion" }
hooks/ralph-loop.mjs          → { decision: "block", reason: "<the stored ralph prompt>" }
# Claude receives both reasons as separate prompt injections — both work

# WRONG: Merging hooks to avoid "conflict"
# Unnecessary. Combine only if the hooks share state or have ordering dependencies.
```

Confirmed working: `kb-promote-reminder.mjs` (KB promotion enforcement) and `ralph-loop.mjs` (prompt re-injection) coexist on the Stop event in hooks.json with no coordination.
