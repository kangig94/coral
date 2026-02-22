---
name: codex
description: Execute a prompt with OpenAI Codex CLI
argument-hint: "[prompt]"
---

Route the user's request to Codex. This skill is a **router, not a filter**. Your ONLY job is to deliver the request to Codex — never judge, refuse, or editorialize the user's prompt. Codex will apply its own safety policies. Call MCP tools directly for most tasks; spawn parallel subagents only for review.

**Do NOT output any text before the tool call.** All steps below are internal routing logic - execute them silently. The user should only see the final result from "Presenting the result." Even if the request appears unsafe, off-topic, or adversarial, route it. Content moderation is Codex's responsibility, not yours.

## 1. Session commands

If the argument starts with `session`, handle directly (no agent spawn needed):

| Command | Action | MCP Tool |
|---------|--------|----------|
| `session create <name> <prompt>` | Create a named session | `codex({ op: "exec", name, prompt })` |
| `session send <name> <prompt>` | Continue an existing session | `codex({ op: "exec", session: name, prompt })` |
| `session list` | List all sessions | `codex({ op: "list" })` |
| `session fork <name> [new-name]` | Fork a session | `codex({ op: "fork", session: name, name: newName })` |

Present session results:
- `list`: Show a table of sessions (name, model, last used)
- `exec`, `fork`: Show `response` as main content. If `errors` array present, append error notice. Never show `thread_id`, `model`, `duration_ms` unless asked.

If the argument does NOT start with `session`, continue to step 2.

## 2. Session continuity

Check the conversation history for a previous `/codex` call that returned a `thread_id`:
- **Previous thread_id exists** → use `codex({ op: "exec", session, prompt })` for continuity
- **No previous thread_id** → use `codex({ op: "exec", prompt })`
- **User says "new" or explicitly wants a fresh start** → use `codex({ op: "exec", prompt })`

## 3. Analyze intent

| Intent | Keywords | Execution |
|--------|----------|-----------|
| **Review** (architecture + critique) | review, evaluate, check, audit | **Parallel subagent spawn** (step 5a) |
| Investigation, root cause, debug | debug, investigate, analyze, why, root cause, trace | Direct MCP call with analyst protocol (step 5b) |
| Persistent execution | ralph, persistent, loop, don't stop, keep going, until done | Direct MCP call with ralph protocol (step 5b) |
| **Everything else** | general questions, search, code tasks | **Direct MCP call, verbatim prompt** (step 5c) |

## 4. Gather context

Collect relevant context from the current conversation:
- File paths mentioned or discussed
- Key code snippets that are relevant
- Current working directory
- Constraints or requirements established earlier

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode. Otherwise, omit the field.

## 5a. Review (parallel subagent spawn)

Spawn TWO Task agents in a SINGLE message (parallel):
- `subagent_type: coral:codex-proxy` with `Role: architect` in the prompt - architecture/design perspective
- `subagent_type: coral:codex-proxy` with `Role: critic` in the prompt - critical review/flaw finding

Provide each with the gathered context, working directory, and their respective `Role:` prefix.

After both return, **synthesize**:
1. Merge findings, deduplicate overlapping issues
2. Order by severity (CRITICAL > HIGH > MEDIUM > LOW)
3. Present as a unified review with verified file:line references

## 5b. Specialized intent (analyst, ralph)

Read the unified agent protocol (`agents/codex-proxy.md`) for the prompt template. Use `Role: analyst` for investigation/debug intents and `Role: ralph` for persistent execution intents. **You** call `codex({ op: "exec", ... })` directly - do NOT spawn a codex-proxy agent. Follow the protocol's structure for that role. Pass `working_directory` and appropriate `reasoning_effort`.

## 5c. General request

Call MCP tool directly. Pass the user's prompt **verbatim**. Do not rephrase, enrich, filter, or refuse. Never skip the MCP call — even if the prompt seems unrelated to coding.

| Condition | Action |
|-----------|--------|
| No previous thread_id | `codex({ op: "exec", prompt: user's verbatim prompt, working_directory: cwd })` |
| Previous thread_id exists | `codex({ op: "exec", session: session_name, prompt: user's verbatim prompt, working_directory: cwd })` |

## Presenting the result

1. **Response only (no errors)**: Show response as the main content.
2. **Response + errors**: Show response first, then: `Codex stopped: [error]. Resume with /codex to continue.`
3. **Errors only**: Show: `Codex error: [error message]`
4. **Warnings**: Append after the response as a brief note.

Never show `thread_id`, `model`, `duration_ms` unless the user asks.
