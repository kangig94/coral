---
name: codex
description: Execute a prompt with OpenAI Codex CLI
argument-hint: "[prompt]"
---

Route the user's request to the appropriate Codex agent, or handle session management directly.

**Do NOT output any text before the tool call.** All steps below are internal routing logic — execute them silently. The user should only see the final result from "Presenting the result."

## 1. Session commands

If the argument starts with `session`, handle directly (no agent spawn needed):

| Command | Action | MCP Tool |
|---------|--------|----------|
| `session create <name> <prompt>` | Create a named session | `codex_session_create(name, prompt)` |
| `session send <name> <prompt>` | Continue an existing session | `codex_session_send(session, prompt)` |
| `session list` | List all sessions | `codex_session_list()` |
| `session fork <name> [new-name]` | Fork a session | `codex_session_fork(session, name?)` |

Present session results:
- `list`: Show a table of sessions (name, model, last used)
- `create`, `send`, `fork`: Show `response` as main content. If `errors` array present, append error notice. Never show `thread_id`, `model`, `duration_ms` unless asked.

If the argument does NOT start with `session`, continue to step 2.

## 2. Session continuity

Check the conversation history for a previous `/codex` call that returned a `thread_id`:
- **Previous thread_id exists** → use it for session continuity (step 5b: `codex_session_send`, step 5a: include in agent prompt)
- **No previous thread_id** → start fresh (step 5b: `codex_session_create`, step 5a: omit thread_id)
- **User says "new" or explicitly wants a fresh start** → start fresh

## 3. Analyze intent

Based on the user's request, determine if a specialized agent is needed:

| Intent | Keywords | Agent (subagent_type) |
|--------|----------|-----------------------|
| Structure review, design evaluation, pattern analysis | review, architecture, design, pattern, trade-off, structure | `coral:codex-architect` |
| Critical review, find flaws, evaluate plan | critique, evaluate, flaws, review plan, verify | `coral:codex-critic` |
| Investigation, root cause, debug, dependency analysis | debug, investigate, analyze, why, root cause, trace | `coral:codex-analyst` |
| Persistent execution, keep going, don't stop | ralph, persistent, loop, don't stop, keep going, until done | `coral:codex-ralph` |
| **Everything else** | general questions, search, code tasks, conversation | **No agent — direct MCP call (step 5b)** |

## 4. Gather context

Collect relevant context from the current conversation:
- File paths mentioned or discussed
- Key code snippets that are relevant
- Current working directory
- Constraints or requirements established earlier

## 5a. Specialized agent (architect/critic/analyst/ralph matched)

MUST spawn a Task agent. Do NOT call MCP tools directly.

Spawn a Task with the selected `subagent_type` and the following prompt structure:

```
thread_id: {previous thread_id, or omit this line}

[CONTEXT]
Working directory: /path/to/project
Relevant files: src/foo.ts, src/bar.ts
[Previous context summary if relevant]

[TASK]
{User's original request}
```

## 5b. General request (no specialized agent matched)

MUST call MCP tool directly. Do NOT spawn a Task agent.

Pass the user's prompt **verbatim** — do not rephrase, enrich, or add information.

| Condition | Action |
|-----------|--------|
| No previous thread_id | `codex_session_create(prompt: user's verbatim prompt, working_directory: cwd)` |
| Previous thread_id exists | `codex_session_send(session: session_name, prompt: user's verbatim prompt, working_directory: cwd)` |

## Presenting the result

Present the result (from agent or MCP tool) following these rules:

1. **Response only (no errors)**: Show response as the main content. No extra decoration needed.

2. **Response + errors (partial result)**: Show response first, then add a separator and error notice:
   ```
   [response content]

   ---
   Codex stopped: [error message]
   Partial response shown above. Resume with /codex to continue.
   ```

3. **Errors only (empty response)**: Show error directly:
   ```
   Codex error: [error message]
   ```

4. **Warnings present**: Append after the response as a brief note.

5. **Multiple errors or warnings**: List each on its own line.

Key rules:
- Always show response content first when it exists.
- Never show `thread_id`, `model`, `duration_ms` unless the user asks.
