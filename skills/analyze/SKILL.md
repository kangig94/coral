---
name: analyze
description: "Deep analysis - project scanning, requirement gaps, root cause investigation. Pass --codex to delegate to Codex CLI."
argument-hint: "[--codex] [investigation target or question]"
---

# Deep Analysis & Investigation

Execute thorough analysis by selecting the appropriate agent protocol, or delegate to Codex CLI.

## Argument Routing

| Argument | Mode |
|----------|------|
| `<prompt>` | Claude-native (default) |
| `--codex` | Codex delegation (context from conversation) |
| `--codex <prompt>` | Codex delegation |

Strip the `--codex` flag before passing the prompt to the execution path.

## Claude-native Execution (default)

Cumulative pipeline — evaluate each step against the user's request AND prior findings. Run applicable steps in order; skip steps that aren't needed.

1. **Create analysis file**: Write `.claude/coral/analysis/{YYYY-MM-DD}-{topic}.md` with header:
   ```markdown
   # Analysis: {topic}
   Date: {YYYY-MM-DD}
   Question: {user's original request}
   ```

2. **Step 1 — Project Scan** (scanner):
   Needed when: project structure, architecture, dependencies, or systemic process issues are relevant.
   If yes: Read `agents/scanner.md`, execute its Investigation_Protocol. Append output under `## Scan Report`.

3. **Step 2 — Gap Analysis** (gap-finder):
   Needed when: requirement gaps, acceptance criteria, API contracts, or scope risks are involved — either from the user's request OR from gaps discovered in Step 1.
   If yes: Read `agents/gap-finder.md`, execute its Investigation_Protocol with the analysis file as context. Append output under `## Gap Analysis`.

4. **Step 3 — Root Cause Diagnosis** (debugger):
   Needed when: bugs, errors, crashes, or unexpected behavior need explanation — either from the user's request OR from symptoms surfaced in prior steps.
   If yes: Read `agents/debugger.md`, execute its Investigation_Protocol with the analysis file as context. Append output under `## Root Cause Diagnosis`.

5. **Present**: Show the saved file path to the user, then summarize key findings inline.

At least one step must run. Use Claude-native tools throughout: Read, Grep, Glob, Bash (git only).
Agent protocols are READ-ONLY — **you** (the skill executor) append to the file after each step.

## Codex Delegation

Same cumulative pipeline, but each step delegates to Codex CLI via `agents/codex-proxy.md` prompt templates. **You** call Codex directly — do NOT spawn a codex-proxy agent. Pass `working_directory` and `reasoning_effort: "xhigh"` on every call.

1. **Create analysis file**: Same as Claude-native Step 1.

2. **Step 1 — Project Scan** (Codex → `Role: scanner`):
   Needed when: same criteria as Claude-native.
   If yes: Call `codex({ op: "exec", ... })` with scanner prompt template. Post-process response, then append under `## Scan Report`.

3. **Step 2 — Gap Analysis** (Codex → `Role: gap-finder`):
   Needed when: same criteria as Claude-native (user request + prior findings from file).
   If yes: Include analysis file content as context. Call Codex with gap-finder template. Post-process, append under `## Gap Analysis`.

4. **Step 3 — Root Cause Diagnosis** (Codex → `Role: debugger`):
   Needed when: same criteria as Claude-native (user request + symptoms from prior steps).
   If yes: Include analysis file content as context. Call Codex with debugger template. Post-process, append under `## Root Cause Diagnosis`.

5. **Present**: Show the saved file path to the user, then summarize key findings inline.

**Post-processing** (apply after each Codex call before appending):
- **Verify references**: For CRITICAL/HIGH findings, Read the cited file:line to confirm accuracy. Drop findings with incorrect references.
- **Relevance check**: For each finding, ask "could this be an indirect cause or contributing factor?" If clearly unrelated (different subsystem, no shared state or dependency), move to a `### Peripheral Findings` section at the end rather than discarding.
- **Restructure**: Order by severity with verified references

## Output Protocol

Every analysis invocation MUST save results to a file — created in Step 1 of Claude-native, or after post-processing in Codex delegation.

- **File path**: `.claude/coral/analysis/{YYYY-MM-DD}-{topic}.md`
- **Topic naming**: 2-4 word kebab-case (e.g., `auth-flow-gaps`, `repo-architecture`, `ci-pipeline-root-cause`)
- **Collision**: If the file already exists (same date + topic), append a numeric suffix: `-2`, `-3`

## Context Enhancement

From the current conversation, identify and include in your analysis:
- For project scans: the working directory path and any reference material
- For investigations: error messages, stack traces, reproduction steps
- For requirements: feature specs, API contracts, design documents
- What has already been tried or ruled out

## Error Policy

If the selected agent file cannot be read, report the error to the user. Do not fall back to inline analysis - the agent protocol is a required dependency.
