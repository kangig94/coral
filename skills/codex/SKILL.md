---
name: codex
description: Execute a prompt with OpenAI Codex CLI
argument-hint: "[prompt]"
---

Route the user's request to the appropriate Codex agent.

## 1. Session continuity

Check the conversation history for a previous `/codex` call that returned a `thread_id`:
- **Previous thread_id exists** → include it in the agent prompt for session continuity
- **No previous thread_id** → omit (agent will start a new session)
- **User says "new" or explicitly wants a fresh start** → omit thread_id

## 2. Analyze intent and select agent

Based on the user's request, select the appropriate agent:

| Intent | Keywords | Agent (subagent_type) |
|--------|----------|-----------------------|
| Structure review, design evaluation, pattern analysis | review, architecture, design, pattern, trade-off, structure | `coral:codex-architect` |
| Critical review, find flaws, evaluate plan | critique, evaluate, flaws, review plan, verify | `coral:codex-critic` |
| Investigation, root cause, debug, dependency analysis | debug, investigate, analyze, why, root cause, trace | `coral:codex-analyst` |
| Persistent execution, keep going, don't stop | ralph, persistent, loop, don't stop, keep going, until done | `coral:codex-ralph` |
| Code execution, fix, implement, modify, build | fix, implement, create, build, refactor, modify, write | `coral:codex-delegate` |

## 3. Gather context

Collect relevant context from the current conversation:
- File paths mentioned or discussed
- Key code snippets that are relevant
- Current working directory
- Constraints or requirements established earlier

## 4. Spawn agent

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

## Presenting the result

The agent returns a response. Present it following these rules:

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
