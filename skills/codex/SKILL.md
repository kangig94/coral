---
name: codex
description: Execute a prompt with OpenAI Codex CLI
argument-hint: "[prompt]"
allowed-tools: mcp__cx__codex_execute, mcp__cx__codex_session_send, mcp__cx__codex_session_create
---

Send the user's request to Codex.

## Before calling Codex

### 1. Session continuity

Check the conversation history for a previous `/codex` call that returned a `thread_id`:
- **Previous thread_id exists** → use `mcp__cx__codex_session_send` with that thread_id to continue the session
- **No previous thread_id** → use `mcp__cx__codex_execute` to start a new session
- **User says "new" or explicitly wants a fresh start** → use `mcp__cx__codex_execute` regardless

### 2. Analyze intent and select persona

Based on the user's request, select the appropriate persona:

| Intent | Keywords | Persona |
|--------|----------|---------|
| Structure review, design evaluation, pattern analysis | 구조, 설계, 아키텍처, review, architecture, design, pattern, trade-off | **architect** |
| Critical review, find flaws, evaluate plan | 리뷰, 비판, 평가, critique, evaluate, flaws, review plan | **critic** |
| Investigation, root cause, debug, dependency analysis | 분석, 조사, 원인, debug, investigate, analyze, why | **analyze** |
| Persistent execution, keep going, don't stop, complete everything | ralph, 끝까지, 완료, 반복, persistent, loop, don't stop, keep going | **ralph** |
| Code execution, fix, implement, modify, build | 수정, 구현, 고쳐, 만들어, fix, implement, create, build, refactor | **(none)** |

### 3. Prepend persona system prompt

If a persona is selected, load the corresponding agent protocol and extract the SYSTEM prompt:

**architect:** Read `agents/codex-architect.md` and extract the `<Prompt_Template>` section's SYSTEM prompt.

**critic:** Read `agents/codex-critic.md` and extract the `<Prompt_Template>` section's SYSTEM prompt.

**analyze:** Read `agents/codex-analyst.md` and extract the `<Prompt_Template>` section's SYSTEM prompt.

**ralph:** Read `agents/codex-ralph.md` and extract the `<Prompt_Template>` section's SYSTEM prompt.

**(none):** No system prompt. Pass the enhanced prompt directly.

If an agent protocol file cannot be read, report the error to the user. Do not use inline fallback prompts.

### 4. Enhance with conversation context

Before sending to Codex, add relevant context from the current conversation:
- File paths mentioned or discussed
- Key code snippets that are relevant
- Current working directory context
- Constraints or requirements established earlier

Format:
```
[CONTEXT]
Working directory: /path/to/project
Relevant files: src/foo.ts, src/bar.ts
[Previous context summary if relevant]

[SYSTEM prompt if persona selected]

[User's original request]
```

### 5. Call Codex

- New session: `mcp__cx__codex_execute` with the enhanced prompt
- Continuing session: `mcp__cx__codex_session_send` with the thread_id and enhanced prompt

MUST pass `working_directory` on every `codex_execute` and `codex_session_send` call.

## Presenting the result

The tool returns a JSON object with structured fields. Present it following these rules:

1. **Response only (no `errors`, no `warnings`)**: Show `response` as the main content. No extra decoration needed.

2. **Response + errors (partial result)**: Show `response` first, then add a separator and error notice:
   ```
   [response content]

   ---
   Codex stopped: [error message]
   Partial response shown above. Resume with /codex to continue.
   ```

3. **Errors only (empty `response`)**: Show error directly:
   ```
   Codex error: [error message]
   ```

4. **Warnings present**: Append after the response as a brief note:
   ```
   [response content]

   Codex warning: [warning message]
   ```

5. **Multiple errors or warnings**: List each on its own line.

Key rules:
- Always show `response` content first when it exists.
- Never show `thread_id`, `model`, `duration_ms` unless the user asks.
- The `response` field may naturally contain text like "[Error]" — this is NOT an actual error. Only the `errors` array contains real errors.
