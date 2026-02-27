# Agents

Coral provides two types of agents:

- **Claude-native agents**: Claude Code performs analysis directly using its native tools. Default routing target.
- **Codex-bound agents**: Proxy agents that delegate work to Codex CLI. Used only on explicit request.

## Routing Rules

| User Request | Routing | Reason |
|---|---|---|
| "review with architect" | Claude-native (`architect`) | Default |
| "review with codex architect" | Codex-bound (`codex-proxy` Role:architect) | Explicit "codex" keyword |
| "review with critic" | Claude-native (`critic`) | Default |
| "review with codex critic" | Codex-bound (`codex-proxy` Role:critic) | Explicit "codex" keyword |
| "run ralph on this task" | Skill (`/coral:ralph`) | Default — ralph is a skill/protocol, not an agent |
| "codex ralph this task" | Skill (`/coral:ralph --codex`) | Delegates to Codex via `codex-proxy` Role:ralph |

---

## Claude-native Agents

Use Claude's native tools (Read, Grep, Glob, LSP) for direct analysis. Read-only agents use `disallowedTools: Write, Edit`. Execution agents (ralph) have full tool access.

### architect (Architecture Analysis)

`agents/architect.md` - opus, read-only

**Role**: Architecture analysis and debugging advisor. Reviews code structure, design patterns, dependency graphs, and provides actionable guidance.

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

`skills/ralph/PROTOCOL.md` - sonnet (protocol-only, no agent file)

**Role**: Persistent task executor that loops until work is fully complete with verified evidence. Enforces the Iron Law: no completion claims without fresh verification evidence. Includes a verification gate (IDENTIFY → RUN → READ → VERIFY → CLAIM), iteration cap, and circuit breaker.

> Note: ralph has no agent file. Skills (`/coral:ralph`, `/coral:debug`) and callers (`init-project`) read PROTOCOL.md directly.

---

### planner (Multi-Round Planning)

`skills/plan/PROTOCOL.md` - opus (protocol-only, no agent file)

**Role**: Synthesizer that writes and verifies plans through multi-round review. Spawns parallel reviewer agents (architect+critic), synthesizes feedback using Adopt/Adapt/Defer/Diverge classification, and iterates until no CRITICAL/HIGH findings remain. With `--codex`, runs Codex review (Phase 1) before Claude review (Phase 2). Never implements - planning only.

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

**Role**: Orchestrates multi-agent discussions through structured turn-taking. Manages session setup, team creation, bidding coordination, turn resolution, epoch transitions (auto-triggered by server), and synthesis delivery. Never speaks on substance - only process control.

**Protocol**: Setup (persona seeding via `discuss_lead({ op: "_1_seed", ... })` → persona generation → `discuss_lead({ op: "_2_create", ... })` → team + teammates) → Discussion Loop (broadcast → `discuss_lead({ op: "_3_step", ... })` blocks until all bids resolved → winner branch → `discuss_lead({ op: "_3_step", ... })` blocks until speech done → repeat) → Synthesis (`discuss_lead({ op: "_7_end", ... })` → full transcript via `discuss_lead({ op: "_4_transcript", ... })` → present to user → cleanup).

> Note: discuss-lead does NOT have `disallowedTools` - it needs Task (spawn agents), SendMessage (broadcast), TeamCreate/TeamDelete, and all discuss MCP tools.

---

### discussant (Discussion Participant)

`agents/discussant.md` - sonnet

**Role**: Participates in discussions with a unique persona provided at spawn time. Submits bids via `discuss({ op: "bid", ... })`, reads transcript before speaking, delivers speeches via `discuss({ op: "speak", ... })`, and notifies the team lead after each speech. Uses sonnet - the discussion protocol is well-defined, opus-level reasoning is unnecessary.

---

### persona-generator (Persona Creator)

`agents/persona-generator.md` - opus

**Role**: Single-shot persona generator. Reads the template (`skills/discuss/template/persona-template.md`), generates a unique persona differentiated from team_roles, and outputs clean raw markdown. Uses opus for high-quality persona creation that requires creativity and specificity.

> Template: `skills/discuss/template/persona-template.md` defines the required structure (`# Name - Role`, 4 sections: Expertise, Perspective, Communication Style, Core Focus).

---

## Codex-bound Agents (Delegation Agents)

Proxy agents that delegate work to Codex CLI. Tool restrictions limit them to coral MCP tools only.

**Why one file?** All Codex delegation roles share ~60% identical protocol (Proxy_Protocol, Working_Directory, Session_Continuity, Output_Handling, Failure_Modes). A single file maximizes prompt cache hits - when architect + critic are spawned in parallel, their system prompts share an identical prefix, so only the first pays the full cost. New roles should be added here, not as separate agent files.

### codex-proxy (Unified Codex Delegation Proxy)

`agents/codex-proxy.md` - sonnet, Codex tools only

**Role**: Single proxy agent with role-based routing. Callers include `Role: scanner|gap-finder|debugger|architect|critic|ralph` in their prompt to select the appropriate prompt template and settings. Missing role → explicit error (no inference).

| Role | Purpose | reasoning_effort |
|---|---|---|
| `scanner` | Project scanning, process investigation, systemic root cause analysis | xhigh |
| `gap-finder` | Requirements gap analysis, dependency tracing, technical investigation | xhigh |
| `debugger` | Bug diagnosis via hypothesis testing, root cause tracing | xhigh |
| `architect` | Architecture review, design patterns, code structure | xhigh |
| `critic` | Plan/code critique, severity-rated verdicts (APPROVED/REVISE/REJECT) | xhigh |
| `ralph` | Single-shot task execution; Claude controls the outer verification loop | xhigh |

> **Ralph note**: `codex-proxy` with `Role: ralph` executes one round. The caller (`/coral:ralph --codex`) controls the loop - spawning with the saved `session` for session continuity until all criteria pass.

---

## Routing Guarantee (Triple Layer)

Three layers ensure Codex-bound agents always delegate to Codex CLI:

### Layer 1: Hook-based Injection (100% guarantee)

The `SubagentStart` hook fires when any agent matching `(^|:)codex-` starts (e.g., `codex-proxy`, `coral:codex-proxy`). It injects delegation instructions via `additionalContext`.

> Claude-native agents (`architect`, `critic`, `scanner`, `gap-finder`) lack the `codex-` prefix, so the hook never matches them.

### Layer 2: Tool Restriction (100% guarantee)

The `tools` field in Codex-bound agent definitions restricts them to coral MCP tools only.

> Claude-native agents have no `tools` restriction - they can use all read tools (`disallowedTools` only blocks writing).

### Layer 3: System Prompt (99%+ guarantee)

Each agent `.md` file contains a detailed role and protocol embedded in the system prompt.

---

## Adding New Agents

### Codex-bound Agent (new role)

Add a new role to `agents/codex-proxy.md` under `<Role_Routing>` and `<Prompt_Templates>`. The existing `codex-proxy` agent handles all Codex delegation roles - callers pass `Role: <name>` in their prompt.

If a standalone Codex agent is truly needed (rare), create `agents/codex-<name>.md` - the `codex-` prefix ensures the hook fires automatically:

```yaml
---
name: codex-<name>
description: <description>
tools: mcp__plugin_coral_cx__codex
---
```

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
