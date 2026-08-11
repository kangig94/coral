---
name: analyze
description: 'Use when deep investigation is needed — project structure, requirement gaps, or root cause diagnosis. Supports --delegate.'
argument-hint: '[--delegate] [investigation target or question]'
---

# Deep Analysis & Investigation

<Role>
  You are the Analyze orchestrator. Agent protocols provide the investigation methodology —
  you execute them and record output. Never generate findings without an agent protocol.
</Role>
<Argument_Routing>
  | Argument | Mode |
  |----------|------|
  | `<prompt>` | Self-execute on current host (default) |
  | `--delegate` | Delegate to the other host (Claude → Codex, Codex → Claude, Copilot → Codex; current host comes from SessionStart `Current host:`) |
  | `--delegate <prompt>` | Same with prompt |

Strip the `--delegate` flag before passing the prompt to the execution path.
</Argument_Routing>
<Protocol>

## Phase 1 — Create Analysis File

Write `CORAL_PROJECT/analysis/{YYYY-MM-DD}-{topic}.md` with header:

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

**Self-execute (default)**: Spawn `Agent({ subagent_type: "coral:<agent>", prompt: "--deep " + prompt })`.
Wait for the agent to return its findings.
You (the executor) post-process and append the result to the file after each step completes.

**Delegate (`--delegate`)**: run `coral-cli <other-host> <role_name> -i "<--deep prompt>" --work-dir "<work_dir>" -d` where `<other-host>` is the delegation target for the current host (Claude → Codex, Codex → Claude, Copilot → Codex)
with scope, `work_dir`, and analysis file content so far.
Run one step at a time — do NOT launch steps in parallel. Each step's output informs
the next step's scope and "Needed when" evaluation.
Each step is a fresh call (no session continuity — each agent has a different role).
After each launch: capture `job` from `Job <job> <launchState> (session <session>)`, then run `coral-cli wait jobs <job> --embed`. Classify the result from its rendered output, not exit code `75` alone: `Result path: <path>` marks a terminal result, so read that artifact and stop waiting even when a terminal `provider_exit` propagated code `75`; a status beginning `Still waiting` with `(cursor: <cursor>)` means the job is still live, so resume with `coral-cli wait jobs <job> --cursor <cursor> --embed`. If a transient error instead prints `remediation:`, follow that exact command. A non-zero `provider_exit` code is terminal and is passed through unchanged (0–255).
On error, abort the chain and report the error.
You (the executor) post-process and append the result to the file after each step completes.

### Steps

| Step                     | Agent file         | Needed when                                                                                                                 | Output section            |
| ------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1 — Project Scan         | `coral:scanner`    | Project structure, architecture, dependencies, or systemic process issues are relevant                                      | `## Scan Report`          |
| 2 — Gap Analysis         | `coral:gap-finder` | Requirement gaps, acceptance criteria, API contracts, or scope risks — from the user's request OR gaps discovered in Step 1 | `## Gap Analysis`         |
| 3 — Root Cause Diagnosis | `coral:debugger`   | Bugs, errors, crashes, or unexpected behavior — from the user's request OR symptoms surfaced in prior steps                 | `## Root Cause Diagnosis` |

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
