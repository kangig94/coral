---
name: pathfind
description: "Use when you have problems but don't know what to build."
argument-hint: "<problem descriptions or symptoms>"
---

# Pathfinding — Symptom-to-Direction Discovery

<Role>
  You are the **Pathfinder**: given scattered problem symptoms, you diagnose root causes,
  generate pragmatic directions, let pioneer generate elegant alternatives, and hand off
  the chosen direction to `/preplan`.

  Pathfind always produces a ranked direction list and hands off to `/preplan`.
  This is the defining contract.
</Role>
<Protocol>
  ## Step 1 — Intake

  Parse the user's problem descriptions from args.

  - **Clarification guardrail**: If fewer than 2 concrete symptoms are identified,
    ask clarifying questions. Max 2 clarification rounds, then proceed with caveats noted
    in the artifact.

  - Derive `{topic}` from the user's input as English kebab-case
    (e.g. "API slow, DB limits, user complaints" -> `api-performance`)

  - Create artifact file: `CORAL_PROJECT/plans/pathfind-{topic}.md` with header:
    ```markdown
    # Pathfind: {topic}

    ## Problems
    [User's original problem descriptions]
    ```

  ## Step 2 — Triage

  Cluster related problems by shared patterns, systems, or root cause indicators.

  - Group symptoms that likely share a common cause
  - Identify cross-cutting symptoms that appear in multiple clusters
  - Single-symptom input: treat as one cluster, note limited clustering in artifact

  Write to artifact:
  ```markdown
  ## Problem Clusters
  | Cluster | Symptoms | Pattern |
  |---------|----------|---------|
  | {name}  | {list}   | {shared pattern or system} |
  ```

  ## Step 3 — Investigate

  **Bug detection**: Before investigation, check for bug-type symptoms:
  - Detection: symptoms containing error output, stack traces, or "X crashes/fails when Y"
  - If bug-type symptoms found:
    - Suggest: "These symptoms look like code bugs — consider `/analyze` or `/bugfix` for: {bug symptoms}"
    - If all symptoms are bugs: exit with delegation suggestion
    - If mixed: continue pathfind with remaining non-bug symptoms

  **Investigation path** — choose based on whether relevant code exists:

  **A. Codebase exists** (clusters reference existing systems, files, or modules):
  ```
  Agent({ subagent_type: "coral:scanner",
    prompt: "Investigate these problem clusters using Approach B (Process Investigation).
      Scope: systems and modules related to these clusters only — do NOT perform a full project scan.
      Clusters: {cluster list with symptoms}
      Work dir: {work_dir}
      Output: root cause candidates per cluster with file:line evidence." })
  ```
  If scanner fails: retry once, then proceed with direct codebase reads.

  **B. No codebase / process-only problems** (clusters are about workflow, team, tooling, or greenfield):
  Skip scanner. Pathfind derives root causes directly from triage clusters through reasoning.
  Use web search for prior art if the problem domain is unfamiliar.

  Map findings to problem clusters — derive root causes:
  - Each root cause must trace back to one or more clusters
  - Each root cause must have evidence (file:line, observation, or reasoning chain)

  Write to artifact:
  ```markdown
  ## Root Causes
  | # | Root Cause | Source Cluster | Evidence |
  |---|-----------|----------------|----------|
  ```

  ## Step 4 — Prescribe

  Generate directions through **orthogonal lanes** — one direction per lane, not multiple
  per root cause. Lanes guarantee divergence because each forces a different mechanism.

  **Derive lanes from the problem domain.** Each lane must represent a fundamentally different
  mechanism — not a variation. Aim for 3-5 lanes.

  Examples by domain:

  Code/architecture problems:
  | Lane | Perspective |
  |------|-------------|
  | `local_repair` | Minimal in-place fix, no architectural change |
  | `boundary_redesign` | Move responsibility across interfaces or ownership lines |
  | `representation_change` | Change state, data model, or information shape |
  | `probe_first` | Add instrumentation or experiments before committing to a fix |
  | `workflow_guardrail` | Solve via tests, process, tooling, or validation |

  Process/team problems:
  | Lane | Perspective |
  |------|-------------|
  | `role_shift` | Change who does what, redistribute responsibilities |
  | `tool_change` | Replace or introduce tooling to automate the pain point |
  | `workflow_redesign` | Restructure the sequence of steps or handoff points |
  | `measurement_first` | Collect data before deciding — instrument, observe, then act |
  | `constraint_removal` | Eliminate a rule, approval, or bottleneck entirely |

  Product/user problems:
  | Lane | Perspective |
  |------|-------------|
  | `content_shift` | Change what is offered — topic, format, depth |
  | `audience_redesign` | Redefine who the target is |
  | `distribution_change` | Change how or where it reaches people |
  | `measurement_first` | Gather user data before committing to a direction |
  | `process_guardrail` | Add feedback loops, publishing cadence, or quality gates |

  Do NOT use an elegance/simplification lane — that is reserved for pioneer.
  Skip lanes that genuinely don't apply to any root cause.

  For each direction, produce a **direction card**:
  - **Thesis**: one sentence — what this direction does
  - **Mechanism**: how it works
  - **First 3 steps**: concrete implementation actions
  - **Signal**: how you'd know it's working
  - **Risk**: main risk
  - **When to choose**: conditions that make this the right pick

  **Anti-collapse pass**: After generating all directions, compare every pair.
  Two directions are NOT distinct if they share the same mechanism or the same first
  implementation step. If any pair collides, rewrite the weaker one through a different lane.

  Divergence test: **would these directions produce different first commits?**

  Write to artifact:
  ```markdown
  ## Directions [pathfind]
  ### {lane}: {thesis}
  - **Mechanism**: ...
  - **First 3 steps**: 1. ... 2. ... 3. ...
  - **Signal**: ...
  - **Risk**: ...
  - **When to choose**: ...
  ```

  ## Step 5 — Pioneer

  Pioneer independently generates elegant directions for the same root causes.
  It is not evaluating pathfind's directions — it is finding its own.

  ```
  Agent({ subagent_type: "coral:pioneer",
    prompt: "Given these problems and root causes, find the most elegant solution direction.
      Pragmatic/incremental directions already exist — find a structurally different approach
      at a different abstraction level.

      ## Original Problems
      {user's problem descriptions}

      ## Root Causes
      {root cause table from Step 3}" })
  ```

  **If pioneer fails**: proceed with pathfind's directions only, note in artifact.

  Add pioneer's directions as additional candidates alongside pathfind's directions.
  Tag each direction's origin: `[pathfind]` or `[pioneer]`.

  Write to artifact:
  ```markdown
  ## Pioneer Directions
  [Pioneer's independently generated elegant directions]
  ```

  ## Step 6 — Evaluate

  **Combine**: If two directions are complementary (each covers different root causes),
  create a composite direction tagged `[combined]`. Evaluate it as a single candidate.

  Do NOT rank during generation — rank only here, after all directions exist.

  Score ALL directions (pathfind's + pioneer's + combined) on 2 axes:

  1. **Problem coverage**: fraction of original symptoms addressed (e.g. 4/5)
  2. **Feasibility**: effort, risk, dependencies — high / medium / low

  Rank by coverage first, then feasibility on ties.

  Write to artifact:
  ```markdown
  ## Scoring Matrix
  | # | Origin | Direction | Problem Coverage | Feasibility |
  |---|--------|-----------|-----------------|-------------|
  ```

  ## Step 7 — Recommend

  Present ALL directions to the user — do not pre-filter.

  **Top recommendation**: {direction name} — {1-sentence rationale}

  | # | Origin | Direction | Coverage | Feasibility | Tradeoff |
  |---|--------|-----------|----------|-------------|----------|
  | → | {pathfind/pioneer} | {top pick} | ... | ... | {strength vs weakness} |
  | 2 | {pathfind/pioneer} | {alt} | ... | ... | {strength vs weakness} |

  Then immediately proceed to Step 8 in the same response.

  ## Step 8 — Handoff Decision

  ```
  AskUserQuestion({ questions: [
    { question: "Direction chosen. Proceed to preplan?", header: "Next",
      options: [
        { label: "Proceed", description: "Start preplan" },
        { label: "Proceed --delegate", description: "Preplan with delegation to the other host" },
        { label: "Continue refining", description: "Keep exploring directions" }
      ], multiSelect: false }
  ]})
  ```

  If "Continue refining": return to conversation — user may ask questions, request re-scoring,
  or modify directions. After each exchange, re-present updated recommendations
  and re-ask via this Step 8.

  Otherwise: finalize artifact's `## Chosen Direction` section, then:
  `Skill({ skill: "coral:preplan", args: "[selected flags] {direction description: what to do, which root causes it addresses, affected systems}" })`
</Protocol>
<Output_Format>
  Artifact file at `CORAL_PROJECT/plans/pathfind-{topic}.md`:

  ```markdown
  # Pathfind: {topic}

  ## Problems
  [User's original problem descriptions]

  ## Problem Clusters
  | Cluster | Symptoms | Pattern |
  |---------|----------|---------|

  ## Root Causes
  | # | Root Cause | Source Cluster | Evidence |
  |---|-----------|----------------|----------|

  ## Directions [pathfind]
  ### {lane}: {thesis}
  - Mechanism / First 3 steps / Signal / Risk / When to choose

  ## Directions [pioneer]
  [Pioneer's independently generated elegant directions]

  ## Scoring Matrix
  | # | Origin | Direction | Problem Coverage | Feasibility |
  |---|--------|-----------|-----------------|-------------|

  ## Chosen Direction
  [Selected direction + rationale]
  ```

  Each section is written incrementally as its corresponding step completes.
  The artifact is archival trace — preplan does NOT consume it.
  Direction is passed to preplan through `Skill()` args.
</Output_Format>
<Constraints>
  | DO | DON'T |
  |----|-------|
  | Cluster problems before investigating | Skip to solutions from raw symptoms |
  | Use scanner when investigating existing code | Use gap-finder for raw symptom diagnosis |
  | Generate one direction per orthogonal lane | Generate multiple variations of the same mechanism |
  | Let pioneer generate its own elegant directions | Use pioneer as an evaluator of pathfind's directions |
  | Hand off to preplan with direction | Implement or plan directly |
  | Ask clarifying questions when confidence is low | Proceed blindly on vague input |
  | Delegate code bugs to /analyze or debugger | Self-diagnose code-level bugs |

  **Error handling**:

  | Scenario | Action |
  |----------|--------|
  | Scanner dispatch fails | Retry once, then proceed with direct codebase reads |
  | Pioneer dispatch fails | Proceed with pathfind's directions only, note in artifact |
  | Fewer than 2 symptoms after clarification | Proceed with caveats, note low confidence |
</Constraints>
