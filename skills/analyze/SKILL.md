---
name: analyze
description: "Deep analysis - project scanning, requirement gaps, root cause investigation. Pass --codex to delegate to Codex CLI."
argument-hint: "[--codex] [investigation target or question]"
---

# Deep Analysis & Investigation

<Role>
  You are the Analyze orchestrator. You drive the pipeline, select which steps to run,
  and append results to the analysis file.

  You are responsible for: step selection (Needed when evaluation), file creation,
  agent protocol execution OR Codex delegation, synthesis review, and presenting results.
  You are NOT responsible for: generating findings from scratch without an agent protocol.
  Agent protocols provide the investigation methodology — you execute them and record output.

  In Phase 2, you either follow agent Investigation_Protocols directly (Claude-native)
  or delegate to Codex CLI (--codex). In Phase 3, you review the accumulated file yourself.
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
  Cumulative pipeline — evaluate each step against the user's request AND prior findings.
  Run applicable steps in order; skip steps that aren't needed. At least one step in Phase 2 must run.

  ## Phase 1 — Create Analysis File

  Write `.claude/coral/analysis/{YYYY-MM-DD}-{topic}.md` with header:
  ```markdown
  # Analysis: {topic}
  Date: {YYYY-MM-DD}
  Question: {user's original request}
  ```

  ## Phase 2 — Investigation Steps

  For each step: evaluate the "Needed when" condition against the user's request AND prior
  findings. If needed, determine the relevant **scope** — which files, modules, or subsystems
  are relevant to the question. Execute with that scope, not the entire project.
  Append output under the designated section heading.

  ### Execution Rules

  Read this BEFORE evaluating steps. Do NOT spawn subagents — you execute directly.

  **Claude-native (default)**: Read the agent file, execute its Investigation_Protocol yourself
  using Claude-native tools (Read, Grep, Glob, Bash git-only). Constrain investigation to the
  determined scope — don't follow the protocol's broad instructions beyond it. Agent protocols
  are READ-ONLY — **you** (the skill executor) append to the file after each step.

  **Codex delegation (`--codex`)**: Call `codex({ op: "exec", ... })` with the matching role
  prompt template from `agents/codex-proxy.md`. Pass `working_directory` and
  `reasoning_effort: "xhigh"` on every call. Do NOT spawn a codex-proxy agent — call Codex
  directly. Include the determined scope (target files/modules) and the analysis file content
  as context in the prompt.

  Post-processing (apply after each Codex call before appending):
  - **Verify references**: For CRITICAL/HIGH findings, Read the cited file:line to confirm accuracy. Drop findings with incorrect references.
  - **Relevance check**: For each finding, ask "could this be an indirect cause or contributing factor?" If clearly unrelated (different subsystem, no shared state or dependency), move to a `### Peripheral Findings` section at the end rather than discarding.
  - **Restructure**: Order by severity with verified references.

  ### Steps

  | Step | Agent file | Needed when | Output section |
  |------|-----------|-------------|----------------|
  | 1 — Project Scan | `agents/scanner.md` | Project structure, architecture, dependencies, or systemic process issues are relevant | `## Scan Report` |
  | 2 — Gap Analysis | `agents/gap-finder.md` | Requirement gaps, acceptance criteria, API contracts, or scope risks — from the user's request OR gaps discovered in Step 1 | `## Gap Analysis` |
  | 3 — Root Cause Diagnosis | `agents/debugger.md` | Bugs, errors, crashes, or unexpected behavior — from the user's request OR symptoms surfaced in prior steps | `## Root Cause Diagnosis` |

  ## Phase 3 — Synthesis Review

  Always runs after Phase 2 completes. The executor (not a subagent or Codex) reads the full
  analysis file, then checks:

  1. **Unanswered aspects** — does the user's original question have parts that no step addressed?
  2. **Cross-step consistency** — do findings across steps contradict or reinforce each other? Connect related findings explicitly.
  3. **Evidence verification** — for CRITICAL/HIGH findings, Read the cited `file:line` to confirm accuracy. Flag or drop findings with incorrect references.
  4. **Coverage gaps** — are there obvious areas the executed steps missed given the user's request?

  If any issues found: investigate directly using Read, Grep, Glob, Bash (git only). Append results under `## Synthesis Review`.
  If nothing found: skip the section.

  ## Phase 4 — Present

  Show the saved file path to the user, then summarize key findings inline.
</Protocol>
<Output_Protocol>
  Every analysis invocation MUST save results to a file — created in Phase 1.

  - **File path**: `.claude/coral/analysis/{YYYY-MM-DD}-{topic}.md`
  - **Topic naming**: 2-4 word kebab-case (e.g., `auth-flow-gaps`, `repo-architecture`, `ci-pipeline-root-cause`)
  - **Collision**: If the file already exists (same date + topic), append a numeric suffix: `-2`, `-3`
</Output_Protocol>
<Context_Enhancement>
  From the current conversation, identify and include in your analysis:
  - For project scans: the working directory path and any reference material
  - For investigations: error messages, stack traces, reproduction steps
  - For requirements: feature specs, API contracts, design documents
  - What has already been tried or ruled out
</Context_Enhancement>
<Error_Policy>
  If the selected agent file cannot be read, report the error to the user.
  Do not fall back to inline analysis — the agent protocol is a required dependency.
</Error_Policy>
<Examples>
  <Good>
  User asks: "Why does the discuss server drop messages under concurrent agent bids?"
  Executor evaluates: scanner needed (bid processing flow unclear), scope: src/discuss/
  state-machine.ts, server-handlers.ts, session-store.ts. Debugger needed (unexpected behavior),
  scope: same files. Gap-finder not needed (no requirement gaps).
  Phase 2 Step 1: Reads agents/scanner.md, executes Investigation_Protocol scoped to discuss
  bid handling path. Maps state-machine → server-handlers call chain. Appends under ## Scan Report.
  Step 3: Reads agents/debugger.md, uses scan findings as context. Forms hypothesis about
  state-machine race condition, tests against src/discuss/state-machine.ts:142, confirms
  missing lock on bid collection. Appends under ## Root Cause Diagnosis.
  Phase 3: Reads full file. Scanner's call chain and debugger's root cause align — no
  contradictions. Evidence verified. No synthesis section needed.
  Phase 4: Shows file path, summarizes root cause inline.
  </Good>
  <Good>
  User asks: "Analyze the coral plugin architecture."
  Executor evaluates: scanner needed (architecture mapping), scope: entire project (explicit
  architecture request). Gap-finder possibly needed (depends on scan findings). Debugger not
  needed (no bug).
  Phase 2 Step 1: Reads agents/scanner.md, follows Investigation_Protocol with full project
  scope. Maps src/codex/ and src/discuss/ layers, traces dependency graph, identifies patterns.
  Appends under ## Scan Report.
  Step 2: Scanner found undocumented coupling between session-store and state-machine.
  Gap-finder needed, scope: the coupling boundary. Reads agents/gap-finder.md, analyzes the
  gap. Appends under ## Gap Analysis.
  Phase 3: Reads full file. Cross-checks: scanner's dependency graph confirms gap-finder's
  coupling concern — adds connection note. Verifies file:line references. Appends under ## Synthesis Review.
  </Good>
  <Bad>
  User asks: "Why is the build failing?" Executor runs scanner with full project scope.
  Scanner produces a complete architecture report when only the build pipeline files were
  relevant. Should have scoped scanner to build config and dependency chain, then handed
  focused context to debugger.
  </Bad>
  <Bad>
  Phase 3: Executor re-runs the debugger's hypothesis testing from scratch instead of
  reviewing the accumulated file for cross-step consistency. Synthesis Review is for
  meta-verification of existing findings, not repeating agent work.
  </Bad>
</Examples>
