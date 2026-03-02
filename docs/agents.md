# Agents

Coral provides Claude-native agents and direct Codex delegation ops:

- **Claude-native agents**: Claude Code performs analysis directly using its native tools. Default routing target.
- **Codex delegation ops**: `codex({ op: "coral:<agent>" })` loads `agents/<agent>.md`, prepends it to the prompt, and executes through Codex CLI.

## Methodology Connections

Agents reference cross-cutting HOW methodology files from `methods/`. Each agent owns one primary methodology (MANDATORY) and optionally one conditional methodology. See [docs/methodology.md](./methodology.md) for the full connection architecture, ownership patterns, and design principles.

## Routing Rules

| User Request | Routing | Reason |
|---|---|---|
| "review with architect" | Claude-native (`architect`) | Default |
| "review with codex architect" | `codex({ op: "coral:architect", ... })` | Explicit "codex" keyword |
| "review with critic" | Claude-native (`critic`) | Default |
| "review with codex critic" | `codex({ op: "coral:critic", ... })` | Explicit "codex" keyword |
| "run ralph on this task" | Skill (`/coral:ralph`) | Default — ralph is a skill/protocol, not an agent |
| "codex ralph this task" | Skill (`/coral:ralph --codex`) | Delegates to Codex directly via `codex` MCP calls |

---

## Claude-native Agents

Use Claude's native tools (Read, Grep, Glob, LSP) for direct analysis. Read-only agents use `disallowedTools: Write, Edit`. Execution agents (ralph) have full tool access.

### architect (Architecture Analysis)

`agents/architect.md` - opus, read-only

**Role**: Architecture analysis and debugging advisor. Reviews code structure, design patterns, dependency graphs, and provides actionable guidance. Also participates as a structural reviewer in the `/plan` protocol — focusing on architectural failure modes, wrong decomposition, and integration conflicts.

---

### critic (Plan/Code Review)

`agents/critic.md` - opus, read-only

**Role**: Verifies that plans and code changes are clear, complete, and correct. For plans: simulates representative tasks step-by-step. For code: validates changes against intent, edge cases, and existing tests. Provides severity-rated findings with OKAY/REJECT verdicts.

---

### debugger (Bug Diagnosis)

`agents/debugger.md` - opus, read-only

**Role**: Systematic bug diagnostician via hypothesis testing, reproduction tracing, and root cause analysis. Produces precise fix specifications with file:line references.

---

### scanner (Project Scan & Process Investigation)

`agents/scanner.md` - opus, read-only

**Role**: Maps project architecture, traces dependencies, and investigates process/system-level root causes. Produces Scan Reports (layer diagram, key modules, patterns, gaps) and Root Cause Reports (process trace, evidence, hypothesis).

---

### gap-finder (Requirements Gap Analysis)

`agents/gap-finder.md` - opus, read-only

**Role**: Identifies requirement gaps, undefined guardrails, and scope risks for new features. Analyzes external constraints, edge cases, and integration risks.

---

### ralph (Persistent Execution Loop)

`skills/ralph/SKILL.md` - sonnet (skill-only, no agent file)

**Role**: Persistent task executor that loops until work is fully complete with verified evidence. Enforces the Iron Law: no completion claims without fresh verification evidence. Includes a verification gate (IDENTIFY → RUN → READ → VERIFY → CLAIM), iteration cap, and circuit breaker.

> Note: ralph has no agent file. The protocol is embedded in `skills/ralph/SKILL.md`. Callers invoke via `Skill("coral:ralph")` — the default execution path naturally follows `<Ralph_Protocol>`.

---

### planner (Multi-Round Planning)

`skills/plan/SKILL.md` - opus (skill-only, no agent file)

**Role**: Orchestrator that writes plans and manages the review loop. Spawns parallel reviewer agents (architect+critic), spawns coral:resolver for feedback synthesis (HOW-SYNTHESIZE + HOW-RESOLVE); applies HOW-COMPLETE.md for exit evaluation. With `--codex`, runs Codex review (Phase 1) before Claude review (Phase 2). Never synthesizes directly, never implements — planning only.

---

### resolver (Feedback Synthesizer & Contradiction Resolver)

`agents/resolver.md` - opus

**Role**: Vada-frame synthesizer that classifies reviewer findings using Adopt/Adapt/Defer/Diverge
with FRAME/STRUCTURE/DETAIL levels. Detects Vyabhicharita (contradictory feedback)
and resolves Constraint Collisions via HOW-RESOLVE's TRIZ protocol. Spawned by plan skill
at step 4b — applies Adopt/Adapt changes directly to the plan file and returns structured
synthesis output for the plan skill's round summary and exit evaluation.
Follows HOW-SYNTHESIZE.md (always) and HOW-RESOLVE.md (on Constraint Collision).

---

### init-project (Project Initialization Orchestrator)

`skills/init-project/SKILL.md` - opus (skill-only, no agent file)

**Role**: Orchestrates project initialization: analyze → plan → execute → verify → report. For existing projects, spawns an analysis subagent (cumulative pipeline) that produces a reusable analysis document. Keeps deterministic generation rules (merge policy, globs detection, directory creation) and passes them to ralph.

> Note: init-project has no agent file — it is a skill-only protocol. It must run at depth 0 (to spawn subagents at depth 1), so it cannot be spawned as a subagent itself.

---

### red-attacker (Adversarial Test Generator)

`agents/red-attacker.md` - sonnet

**Role**: Adversarial test specialist that attacks the implementer's blind spots by generating tests the implementer didn't think to write. Spawned as a background subagent via `/coral:ralph --red`. Pass `--codex` to delegate the entire pipeline (analysis → coverage → attack vectors → test generation) to Codex via multi-round session; default is Claude-direct. Gracefully degrades to Claude-direct with a warning if Codex is unavailable. Ralph automatically passes the opposite `--codex` flag for cross-model diversity.

**Investigation Protocol**: (1) Read existing tests to identify language/framework/naming patterns. (2) Read changed files and existing coverage; cross-reference `plan_context` to avoid duplicating planned tests. (3) Identify attack vectors (boundary, error path, ordering, type, state, security). (4) Write adversarial tests to the project's test directory with `red-<target>.<ext>` naming. (5) Output a coverage gap report.

> Note: red-attacker does NOT have `disallowedTools` because it needs Write/Edit access to create test files.

---

## Discuss Agents

Agents for the moderated multi-agent discussion system. These agents coordinate via the `dc` MCP server (`discuss` and `discuss_lead` tools) and Agent Teams.

### discuss-lead (Discussion Moderator)

`agents/discuss-lead.md` - opus

**Role**: Orchestrates multi-agent discussions through structured turn-taking. Manages session setup, team creation, bidding coordination, turn resolution, epoch transitions (auto-triggered by server), and termination handoff. Never speaks on substance - only process control.

**Protocol**: Setup (persona seeding via `discuss_lead({ op: "_1_seed", ... })` → persona generation → `discuss_lead({ op: "_2_create", ... })` → team + teammates) → Discussion Loop (broadcast → `discuss_lead({ op: "_3_step", ... })` blocks until all bids resolved → winner branch → `discuss_lead({ op: "_3_step", ... })` blocks until speech done → repeat) → Finalization (full transcript via `discuss_lead({ op: "_4_transcript", ... })` → `discuss_lead({ op: "_7_end", ... })` → `discuss_lead({ op: "_8_synthesize", ... })` → present to user → cleanup).

> Note: discuss-lead does NOT have `disallowedTools` - it needs Task (spawn agents), SendMessage (broadcast), TeamCreate/TeamDelete, and all discuss MCP tools.

---

### discussant (Discussion Participant)

`agents/discussant.md` - sonnet

**Role**: Participates in discussions with a unique persona provided at spawn time. Submits bids via `discuss({ op: "bid", ... })`, reads transcript before speaking, delivers speeches via `discuss({ op: "speak", ... })`, and notifies the team lead after each speech. Uses sonnet - the discussion protocol is well-defined, opus-level reasoning is unnecessary.

---

### persona-generator (Persona Creator)

`agents/persona-generator.md` - opus

**Role**: Single-shot persona generator. Structure specification is embedded in the agent's `<Output_Format>` section (header format, 4 required sections: Expertise, Perspective, Communication Style, Core Focus, plus optional Position). Generates a unique persona differentiated from team_roles and outputs clean raw markdown. Uses sonnet for high-quality persona creation that requires creativity and specificity.

---

## Codex Delegation (`coral:*`)

Codex delegation is handled directly by the `codex` MCP tool:

- `codex({ op: "coral:architect", prompt, ... })`
- `codex({ op: "coral:critic", prompt, ... })`
- `codex({ op: "coral:scanner", prompt, ... })`

Behavior:
- The server resolves `agents/<agent>.md` from the `op` suffix.
- Agent file content is prepended to the prompt as-is.
- The call runs through the same async job pipeline as `op: exec`.
- Unknown agent names return `Agent file not found: agents/<agent>.md`.

---

## Adding New Agents

### Codex-delegated Agent Role

Create `agents/<name>.md` and call it via `codex({ op: "coral:<name>", ... })`.
No proxy role table, `codex-` prefix, or hook matcher registration is required.

### Claude-native Agent (Read-only)

Create `agents/<name>.md` (without `codex-` prefix):

```yaml
---
name: <name>
description: "<description>. Use PROACTIVELY when [trigger]. NOT for [exclusion]."
model: opus
disallowedTools: Write, Edit
---
```

```xml
<Agent_Prompt>
  <Role>
    You are [role]. Your mission is [mission].
    You are responsible for: [responsibilities].
    You are NOT responsible for: [exclusions with agent names].

    | Situation | Priority |
    |-----------|----------|
    | [trigger condition] | MANDATORY / RECOMMENDED / OPTIONAL |
  </Role>
  <Success_Criteria>
    - [Measurable criterion 1]
    - [Measurable criterion 2]
  </Success_Criteria>
  <Constraints>
    [ONE-LINE IRON LAW IN CAPS]

    | DO | DON'T |
    |----|-------|
    | [correct behavior] | [incorrect behavior] |
  </Constraints>
  <Investigation_Protocol>
    1) [Step with sub-steps a, b, c]
    2) [Step]
  </Investigation_Protocol>
  <Tool_Usage>
    Detection commands:
    ```bash
    [bash commands to find issues]
    ```

    Key files:
    | File | Concern |
    |------|---------|
    | [file] | [what to check] |
  </Tool_Usage>
  <Output_Format>
    ## Review: [scope]
    ### Findings
    | # | Severity | File:Line | Finding | Suggestion |
    |---|----------|-----------|---------|------------|
    ### Verdict: PASS / NEEDS WORK
  </Output_Format>
  <Failure_Modes_To_Avoid>
    - [Mode]: [What goes wrong]. Instead: [correction].
  </Failure_Modes_To_Avoid>
</Agent_Prompt>
```

### Claude-native Agent (Execution)

Create `agents/<name>.md` without `disallowedTools` for agents that need to write files:

```yaml
---
name: <name>
description: "<description>. Use when [trigger]. NOT for [exclusion]."
model: opus
---
```

```xml
<Agent_Prompt>
  <Role>
    You are [role]. Your mission is [mission].
    You are responsible for: [responsibilities].
    You are NOT responsible for: [exclusions with agent names].

    | Situation | Priority |
    |-----------|----------|
    | [trigger condition] | MANDATORY / RECOMMENDED / OPTIONAL |
  </Role>
  <Success_Criteria>
    - [Measurable criterion 1]
    - [Measurable criterion 2]
  </Success_Criteria>
  <Constraints>
    [ONE-LINE IRON LAW IN CAPS]

    | DO | DON'T |
    |----|-------|
    | [correct behavior] | [incorrect behavior] |
  </Constraints>
  <Investigation_Protocol>
    1) [Step with sub-steps a, b, c]
    2) [Step]
  </Investigation_Protocol>
  <Output_Format>
    ## Report Title
    ### Section
    | Column | Column |
    |--------|--------|
  </Output_Format>
  <Failure_Modes_To_Avoid>
    - [Mode]: [What goes wrong]. Instead: [correction].
  </Failure_Modes_To_Avoid>
</Agent_Prompt>
```
