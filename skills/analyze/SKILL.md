---
name: analyze
description: "Deep analysis - project scanning, requirement gaps, root cause investigation. Pass --deep for HOW method injection, --codex to delegate to Codex CLI."
argument-hint: "[--deep] [--codex] [investigation target or question]"
---

> **CORAL_AGENTS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/agents/")`
> **CORAL_METHODS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/methods/")`

# Deep Analysis & Investigation

<Role>
  You are the Analyze orchestrator. Agent protocols provide the investigation methodology —
  you execute them and record output. Never generate findings without an agent protocol.
</Role>
<Argument_Routing>
  | Argument | Mode |
  |----------|------|
  | `<prompt>` | Claude-native (default) |
  | `--deep` | HOW method injection (combinable with other flags) |
  | `--codex` | Codex delegation (context from conversation) |
  | `--codex <prompt>` | Codex delegation |

  Strip `--deep` and `--codex` flags before passing the prompt to the execution path.
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
  2. **Scope** — determine target files/modules. Never run unscoped. If a step discovers new facets, carry them into subsequent step evaluation.
  3. **Execute** — run via active mode (see Mode below).
  4. **Post-process** — apply quality gates:
     - Verify CRITICAL/HIGH file:line references (Read cited location, drop incorrect)
     - Drop speculative findings without code evidence. Findings about unchanged code: downgrade and move to `### Peripheral Findings`
     - Tag provenance (code trace / test behavior / git history / inference / assumption). Assumption-only → downgrade one level
     - Record finding flow: "N initial → M after gates → K verified [code: X, inference: Y, assumption: Z]"
  5. **Append** — write under the step's output section heading.

  Wait for each step's result before evaluating the next. At least one step must run.

  ### Mode

  **Claude-native (default)**: Read `CORAL_AGENTS/<agent>.md`, follow its Investigation_Protocol
  with Claude-native tools (Read, Grep, Glob, Bash git-only). Constrain to scope.
  You (the executor) append to the file — agent protocols are read-only references.
  **If `--deep`**: read the agent's `methods:` frontmatter, then read each listed HOW file
  from `CORAL_METHODS/` (e.g., `HOW-FALSIFY.md`). Apply HOW methods during that step's execution.

  **Codex (`--codex`)**: call `codex({ op: "coral:<role_name>", ... })` with scope,
  `working_directory`, and analysis file content so far.
  **If `--deep`**: append ` --deep` to the op string (e.g., `coral:scanner --deep`).
  Run one step at a time — do NOT launch steps in parallel. Each step's output informs
  the next step's scope and "Needed when" evaluation.
  Each step is a fresh call (no session continuity — each agent has a different role).
  After each exec: capture `job`, then `wait({ jobs: [job], inline: true })` → read `result.content`.
  On error, abort the chain and report the error.
  You (the executor) post-process and append the result to the file after each step completes.

  ### Steps

  | Step | Agent file | Needed when | Output section |
  |------|-----------|-------------|----------------|
  | 1 — Project Scan | `CORAL_AGENTS/scanner.md` | Project structure, architecture, dependencies, or systemic process issues are relevant | `## Scan Report` |
  | 2 — Gap Analysis | `CORAL_AGENTS/gap-finder.md` | Requirement gaps, acceptance criteria, API contracts, or scope risks — from the user's request OR gaps discovered in Step 1 | `## Gap Analysis` |
  | 3 — Root Cause Diagnosis | `CORAL_AGENTS/debugger.md` | Bugs, errors, crashes, or unexpected behavior — from the user's request OR symptoms surfaced in prior steps | `## Root Cause Diagnosis` |

  ## Phase 3 — Synthesis Review

  Always runs. Read the full analysis file, then:

  1. **Finding flow summary** — counts per step: initial → filtered → verified
  2. **Thematic grouping** (≥2 steps) — group related findings across steps into 2-4 themes. Do NOT restate findings step-by-step. Single step: skip grouping.
  3. **Unanswered aspects** — parts of the user's question no step addressed
  4. **Cross-step consistency** (≥2 steps) — contradictions or reinforcements

  Synthesis is meta-verification of existing findings — do NOT re-run agent investigation.
  If issues found: investigate directly, append under `## Synthesis Review`.
  If clean: append only the finding flow summary.

  ## Phase 4 — Present

  Show the saved file path, then summarize key findings inline.
</Protocol>
<Error_Policy>
  If an agent file cannot be read, report the error to the user. Do not fall back to inline analysis.
</Error_Policy>
