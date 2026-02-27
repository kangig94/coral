---
name: ralph
description: Persistent execution loop with verification (sonnet) - best for implementing an existing plan
argument-hint: "[--red] [--codex] [task description]"
model: sonnet
---

```!
mkdir -p .claude/coral/tmp && touch .claude/coral/tmp/kb-active
```

# Persistent Execution with Verification

Announce at start: "Using ralph to execute this task with verification loop."

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |
| `--red` | Enable adversarial testing (combinable with `--codex`) |

Strip `--codex` and `--red` flags before passing the prompt to the execution path.

## Execution

1. **Load protocol**: Read `PROTOCOL.md` (in this skill directory). If `--codex`, also read `agents/codex-proxy.md` for the prompt template (`### Role: ralph` section). **You** call Codex directly — do NOT spawn a codex-proxy agent.

2. **Execute task**:
   - **Default**: Follow the protocol's `<Protocol>` steps.
   - **`--codex`**: Execution loop:
     a. **Call Codex**: Use `codex({ op: "exec", ... })` (first round) or `codex({ op: "exec", session: <thread_id>, ... })` with saved thread_id (subsequent rounds). Follow the protocol's prompt template. Pass `working_directory` and `reasoning_effort: "xhigh"`.
     b. **Save thread_id** from the response for session continuity
     c. **Verify** the changes yourself: read changed files, compare against acceptance criteria. Use LSP/type-check only. NEVER run build or test during the execution loop.
     d. **Loop decision**: All criteria pass → exit loop, go to Post-Completion Review. Not complete → go to step a with thread_id + updated progress context. Max 5 rounds → ask user whether to continue or finalize.

3. **Post-Completion Review** (`--codex` only):
   **Tests passing does not mean the work is correct.** Codex may produce code that passes tests but diverges from the plan - especially for untestable content (docs, prompts, config).
   a. **Read every changed file** that Codex modified across all rounds
   b. **Compare against the plan/requirements** - does each file match what was specified?
   c. **Flag untestable content** - documentation, markdown, config: verify these match the plan
   d. **Fix discrepancies yourself** - do not send back to Codex; fix them directly
   e. **Report to the user** what was done correctly and what you corrected

4. **Post-implementation**: Follow `<Protocol>` step 6. If `--red`, additionally follow `<Red_Attacker>`.

## Sandbox bypass

Pass `bypass: true` only when the user explicitly requests bypass mode. Otherwise, omit the field.

## Context Enhancement

From the current conversation, identify and include:
- Task description and acceptance criteria
- File paths and code sections relevant to the work
- Current progress and any prior verification results
- Constraints or preferences stated by the user

## Error Policy

If `PROTOCOL.md` (default) or `agents/codex-proxy.md` (`--codex`) cannot be read, report the error to the user. Do not fall back to inline execution - the agent protocol is a required dependency.
