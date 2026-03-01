---
name: analyze
description: "Deep analysis - project scanning, requirement gaps, root cause investigation. Pass --codex to delegate to Codex CLI."
argument-hint: "[--codex] [investigation target or question]"
---

> **CORAL_AGENTS**: `~/.claude/plugins/cache/coral/**/agents/` — locate via Glob

# Deep Analysis & Investigation

<Role>
  You are the Analyze orchestrator. Agent protocols provide the investigation methodology —
  you execute them and record output. Never generate findings without an agent protocol.
</Role>
<Argument_Routing>
  | Argument | Mode |
  |----------|------|
  | `<prompt>` | Claude-native (default) |
  | `--codex` | Codex delegation (context from conversation) |
  | `--codex <prompt>` | Codex delegation |

  Strip the `--codex` flag before passing the prompt to the execution path.
</Argument_Routing>
<Protocol>
  ## Phase 1 — Create Analysis File

  Write `.claude/coral/analysis/{YYYY-MM-DD}-{topic}.md` with header:
  ```markdown
  # Analysis: {topic}
  Date: {YYYY-MM-DD}
  Question: {user's original request}
  ```
  - **Topic**: 2-4 word kebab-case (e.g., `auth-flow-gaps`, `ci-pipeline-root-cause`)
  - **Collision**: same date + topic → append `-2`, `-3`

  ## Phase 2 — Investigation Steps

  For each step in the table below, in order:

  1. **Evaluate** — check "Needed when" against the user's request AND prior findings. Skip if unneeded.
  2. **Scope** — determine target files/modules. Never run unscoped.
  3. **Execute** — run via active mode (see Mode below).
  4. **Post-process** — verify CRITICAL/HIGH references (Read cited file:line, drop incorrect). Move unrelated findings to `### Peripheral Findings`. Order by severity.
  5. **Append** — write under the step's output section heading.

  Wait for each step's result before evaluating the next. At least one step must run.

  ### Mode

  **Claude-native (default)**: Read `CORAL_AGENTS/<agent>.md`, follow its Investigation_Protocol
  with Claude-native tools (Read, Grep, Glob, Bash git-only). Constrain to scope.
  You (the executor) append to the file — agent protocols are read-only references.

  **Codex (`--codex`)**: `Agent("coral:codex-proxy", role: <role_name>)`,
  scope, `working_directory`, and analysis file content so far.
  Spawn one at a time — do NOT launch steps in parallel. Each step's output informs
  the next step's scope and "Needed when" evaluation.
  You (the executor) post-process and append the result to the file after each spawn returns.
  Pass `session: <id>` from the first response to subsequent spawns for Codex CLI context continuity.

  ### Steps

  | Step | Agent file | Needed when | Output section |
  |------|-----------|-------------|----------------|
  | 1 — Project Scan | `CORAL_AGENTS/scanner.md` | Project structure, architecture, dependencies, or systemic process issues are relevant | `## Scan Report` |
  | 2 — Gap Analysis | `CORAL_AGENTS/gap-finder.md` | Requirement gaps, acceptance criteria, API contracts, or scope risks — from the user's request OR gaps discovered in Step 1 | `## Gap Analysis` |
  | 3 — Root Cause Diagnosis | `CORAL_AGENTS/debugger.md` | Bugs, errors, crashes, or unexpected behavior — from the user's request OR symptoms surfaced in prior steps | `## Root Cause Diagnosis` |

  ## Phase 3 — Synthesis Review

  Always runs. Read the full analysis file, then check:

  1. **Unanswered aspects** — does the user's question have parts no step addressed?
  2. **Cross-step consistency** — do findings contradict or reinforce each other? Connect related findings.
  3. **Coverage gaps** — obvious areas the steps missed given the request?

  If issues found: investigate directly (Read, Grep, Glob, Bash git-only). Append under `## Synthesis Review`.
  If clean: skip the section.

  ## Phase 4 — Present

  Show the saved file path, then summarize key findings inline.
</Protocol>
<Context_Enhancement>
  From the current conversation, gather and include:
  - Working directory path and reference material
  - Error messages, stack traces, reproduction steps
  - Feature specs, API contracts, design documents
  - What has already been tried or ruled out
</Context_Enhancement>
<Error_Policy>
  If an agent file cannot be read, report the error to the user. Do not fall back to inline analysis.
</Error_Policy>
<Examples>
  <Good>
  Bug diagnosis with scoped scanning:
  User asks: "Why does the discuss server drop messages under concurrent agent bids?"
  Executor evaluates: scanner needed (bid processing flow unclear), scope: `src/discuss/`
  `state-machine.ts`, `server-handlers.ts`, `session-store.ts`. Debugger needed (unexpected behavior),
  scope: same files. Gap-finder not needed.
  Step 1: Reads `CORAL_AGENTS/scanner.md`, maps state-machine → server-handlers call chain.
  Appends under `## Scan Report`.
  Step 3: Reads `CORAL_AGENTS/debugger.md`, uses scan findings as context. Confirms missing lock
  on bid collection at `state-machine.ts:142`. Post-processed: verified reference — confirmed.
  Appends under `## Root Cause Diagnosis`.
  Phase 3: Scanner's call chain and debugger's root cause align. No synthesis needed.
  </Good>
  <Good>
  Architecture analysis with emergent gap:
  User asks: "Analyze the coral plugin architecture."
  Executor evaluates: scanner needed (architecture mapping), scope: entire project.
  Gap-finder possibly needed (depends on scan). Debugger not needed.
  Step 1: Reads `CORAL_AGENTS/scanner.md`, maps `src/codex/` and `src/discuss/` layers,
  traces dependency graph. Appends under `## Scan Report`.
  Step 2: Scanner found undocumented coupling between session-store and state-machine.
  Gap-finder needed, scope: the coupling boundary. Appends under `## Gap Analysis`.
  Phase 3: Scanner's dependency graph confirms gap-finder's coupling concern — adds connection note.
  Appends under `## Synthesis Review`.
  </Good>
  <Bad>
  Unscoped scanning:
  User asks: "Why is the build failing?" Executor runs scanner with full project scope.
  Should have scoped to build config and dependency chain, then handed focused context to debugger.
  </Bad>
  <Bad>
  Repeated work in synthesis:
  Phase 3: Executor re-runs debugger's hypothesis testing from scratch. Synthesis Review is for
  meta-verification of existing findings, not repeating agent work.
  </Bad>
</Examples>
