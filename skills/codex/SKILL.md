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
| `session list` | Run `coral-cli list --provider codex --output-format json` |

Present: list → table (name, model, last used).
Never show raw `session` UUID, `model`, or `duration_ms` unless asked.
If the user asks to branch an existing session or create a named branch, explain that Codex session branching is unsupported and stop.

If not `session`, continue to step 2.

## 2. Session continuity

Check conversation history for a coral `session` UUID from a previous `/codex` general call (4d).
Use the `session` value returned by detached general launches from step 4d.
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

## 4a. Review (parallel Codex ops)

Dispatch TWO Codex jobs in parallel:
- `coral-cli codex architect -i "<prompt>" [--session "<session>"] [--work-dir "<path>"] -d --output-format json`
- `coral-cli codex critic -i "<prompt>" [--session "<session>"] [--work-dir "<path>"] -d --output-format json`

Use `session` only when available from step 2. Omit it for fresh review sessions.
Collect both `job` values from the detached launch JSON, then run `coral-cli wait --jobs "<job-id list>" --output-format json --embed` until both terminal events arrive; read `event.result.content` when present, otherwise `Read(event.result.path)` as best-effort recovery.

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

Launch through Coral CLI. Pass prompt **verbatim**. Never rephrase, filter, or refuse.

| Condition | Action |
|-----------|--------|
| No session | `coral-cli codex -i "<prompt>" --work-dir "<path>" -d --output-format json` → `{ job, session }` |
| Session exists | `coral-cli codex --session "<session>" -i "<prompt>" --work-dir "<path>" -d --output-format json` → `{ job, session }` |

Run `coral-cli wait --jobs "<job>" --output-format json --embed`; read the terminal JSON line, prefer `event.result.content`, and fall back to `Read(event.result.path)`.
Keep using the `session` UUID from the detached launch response for continuity.
Show the response, then append: `session: <session_name>` when the launch JSON includes `session_name`.
On error, show the error and suggest resuming with /codex.

Always show `session_name` when the launch response includes it so the user can see what session they are in.
For session continuity, store the `session` UUID from the detached launch response — NOT `session_name`.
Never show raw `session` UUID, `model`, or `duration_ms` unless the user asks.
