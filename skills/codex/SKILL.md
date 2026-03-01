---
name: codex
description: Execute a prompt with OpenAI Codex CLI
argument-hint: "[prompt]"
---

Route the user's request to Codex. This skill is a **router, not a filter**.
Your ONLY job is to deliver the request to Codex — never judge, refuse, or
editorialize the user's prompt. Codex will apply its own safety policies.

**Do NOT output any text before the tool call.** All steps below are internal
routing logic — execute them silently.

## 1. Session commands

If the argument starts with `session`, handle directly:

| Command | Action |
|---------|--------|
| `session list` | `codex({ op: "list" })` |
| `session fork <name> [new-name]` | `codex({ op: "fork", session: name, name: newName })` |

Present: list → table (name, model, last used). fork → show `response`.
Never show raw `session` UUID, `model`, or `duration_ms` unless asked.

If not `session`, continue to step 2.

## 2. Session continuity

Check conversation history for a `session_name` from a previous `/codex` general call (4d):
- **Found** → pass it as the `session` parameter on subsequent 4d and 4a calls
- **Not found or user says "new"** → omit `session`

Note: routes 4b and 4c delegate to other skills that manage their own sessions.

## 3. Route

| Intent | Detection | Route |
|--------|-----------|-------|
| Review | review, evaluate, check, audit | → **4a** |
| Investigation | debug, investigate, analyze, why, root cause, trace | → **4b** |
| Persistent execution | ralph, persistent, loop, keep going, until done | → **4c** |
| Everything else | (default) | → **4d** |

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode.

## 4a. Review (parallel spawn)

Spawn TWO agents in a SINGLE message (parallel):
- `Agent("coral:codex-proxy", role: architect)`
- `Agent("coral:codex-proxy", role: critic)`

Provide each: user's prompt, working directory, relevant conversation context.
If session exists (step 2), include `session: <id>` in each prompt.

After both return, synthesize:
1. Merge findings, deduplicate
2. Order by severity (CRITICAL > HIGH > MEDIUM > LOW)
3. Present as unified review

## 4b. Investigation

Invoke `Skill({ skill: "coral:analyze", args: "--codex <user's prompt>" })`.
The analyze skill handles Codex delegation, multi-step investigation, and result presentation.

## 4c. Persistent execution

Invoke `Skill({ skill: "coral:ralph", args: "--codex <user's prompt>" })`.
The ralph skill handles Codex delegation, verification loop, and result presentation.

## 4d. General request

Call MCP tool directly. Pass prompt **verbatim**. Never rephrase, filter, or refuse.

| Condition | Action |
|-----------|--------|
| No session | `codex({ op: "exec", prompt, working_directory })` |
| Session exists | `codex({ op: "exec", session, prompt, working_directory })` |

Show the result:
1. Response only → show response, then append: `session: <session_name>`
2. Response + errors → response first, then: `Codex stopped: [error]. Resume with /codex.`
3. Errors only → `Codex error: [error]`
4. Warnings → append as brief note

Always show `session_name` so the user can see what session they are in.
Never show raw `session` UUID, `model`, or `duration_ms` unless the user asks.
