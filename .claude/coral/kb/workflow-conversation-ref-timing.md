# Workflow conversationRef Availability Timing
Promoted: 2026-03-18 | Updated: 2026-03-18
## Rule
`conversationRef` (the Claude CLI conversation ID used for `.jsonl` session files) is NOT available at atom launch time. It is set by `setConversationRef` in `service.ts` during terminal result processing — after the provider job completes. Any logic that needs `conversationRef` must resolve it at or after terminal time, not at launch time.

## Why
Designing session cleanup or session tracking to collect refs at launch produces undefined values. The ref is only known after the Claude CLI process runs long enough to establish a conversation and report its ID back.

## Pattern
Right: accumulate `LaunchedAtom` metadata at launch, resolve `conversationRef` via `getConversationRef()` at pipeline exit (in `finally` block).
Wrong: add `conversationRef` field to `LaunchedAtom` and populate at launch — will always be `undefined`.

For very early aborts (before CLI establishes a session), `getConversationRef` returns `undefined` and the `.jsonl` file doesn't exist either, so no cleanup is needed.
