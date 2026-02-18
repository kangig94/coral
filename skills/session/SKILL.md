---
name: session
description: Manage Codex conversation sessions
disable-model-invocation: true
argument-hint: "[create|send|list|fork] [args...]"
allowed-tools: mcp__coral__codex_session_create, mcp__coral__codex_session_send, mcp__coral__codex_session_list, mcp__coral__codex_session_fork
---

Manage Codex sessions based on the command:

$ARGUMENTS

Commands:
- create <name> <prompt> - Start a new named session
- send <name> <prompt> - Continue an existing session
- list - Show all sessions
- fork <name> [new-name] - Fork a session

## Presenting the result

For `list`: show a table of sessions (name, model, last used).

For `create`, `send`, `fork`: the tool returns a JSON object with structured fields. Present it following these rules:

1. **Response only (no `errors`, no `warnings`)**: Show `response` as the main content. Mention the session name if created/forked.

2. **Response + errors (partial result)**: Show `response` first, then add a separator and error notice:
   ```
   [response content]

   ---
   Codex stopped: [error message]
   Partial response shown above. Resume: /session send [session_name or thread_id] "continue"
   ```

3. **Errors only (empty `response`)**: Show error directly:
   ```
   Codex error: [error message]
   ```

4. **Warnings present**: Append after the response as a brief note.

5. **Multiple errors or warnings**: List each on its own line.

Key rules:
- Always show `response` content first when it exists.
- Never show `thread_id`, `model`, `duration_ms` unless the user asks.
- The `response` field may naturally contain text like "[Error]" — this is NOT an actual error. Only the `errors` array contains real errors.
