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
| "run ralph on this task" | Claude-native (`ralph`) | Default |
| "codex ralph this task" | Codex-bound (`codex-proxy` Role:ralph) | Explicit "codex" keyword |

---

## Claude-native Agents

Use Claude's native tools (Read, Grep, Glob, LSP) for direct analysis. Read-only agents use `disallowedTools: Write, Edit`. Execution agents (ralph) have full tool access.

### architect (Architecture Analysis)

**File**: `agents/architect.md`

```yaml
---
name: architect
description: "Architecture & debugging advisor. Use PROACTIVELY when reviewing code structure, design patterns, dependency analysis, or debugging complex issues. NOT for requirements analysis (analyst) or plan review (critic)."
model: opus
disallowedTools: Write, Edit
---
```

**Role**: Architecture analysis and debugging advisor. Reviews code structure, design patterns, dependency graphs, and provides actionable guidance.

---

### critic (Plan/Code Review)

**File**: `agents/critic.md`

```yaml
---
name: critic
description: "Plan & code change critic. Use PROACTIVELY when reviewing implementation plans, schema changes, or significant code modifications. NOT for code analysis (architect) or requirements gathering (analyst)."
model: opus
disallowedTools: Write, Edit
---
```

**Role**: Verifies that plans and code changes are clear, complete, and correct. For plans: simulates representative tasks step-by-step. For code: validates changes against intent, edge cases, and existing tests. Provides severity-rated findings with OKAY/REJECT verdicts.

---

### analyst (Requirements Gap Analysis)

**File**: `agents/analyst.md`

```yaml
---
name: analyst
description: "Requirements & gap analyst. Use PROACTIVELY when scoping new features, API changes, state lifecycle changes, or concurrency behavior modifications. NOT for code analysis (architect) or plan review (critic)."
model: opus
disallowedTools: Write, Edit
---
```

**Role**: Identifies requirement gaps, undefined guardrails, and scope risks for new features. Analyzes external constraints, edge cases, and integration risks.

---

### ralph (Persistent Execution Loop)

**File**: `agents/ralph.md`

```yaml
---
name: ralph
description: "Persistent execution loop with verification. Use when a task requires guaranteed completion with evidence-based verification. Loops until all work is done and verified. NOT for one-shot tasks (use executor) or planning (use planner)."
model: sonnet
---
```

**Role**: Persistent task executor that loops until work is fully complete with verified evidence. Enforces the Iron Law: no completion claims without fresh verification evidence. Includes a verification gate (IDENTIFY → RUN → READ → VERIFY → CLAIM), iteration cap, and circuit breaker. Uses sonnet — ralph executes plans that have already been reviewed by architect/critic, so opus-level reasoning is unnecessary.

> Note: ralph does NOT have `disallowedTools` because it needs Write/Edit access to execute tasks.

---

### planner (Multi-Round Planning)

**File**: `agents/planner.md`

```yaml
---
name: planner
description: "Multi-round planning with parallel reviewer verification. Use when a task needs a verified plan before implementation. NOT for direct execution (ralph) or one-shot analysis (architect)."
model: opus
---
```

**Role**: Synthesizer that writes and verifies plans through multi-round review. Spawns parallel reviewer agents (architect+critic or codex variants), synthesizes feedback using Adopt/Adapt/Defer/Diverge classification, and iterates until no CRITICAL/HIGH findings remain. Supports multi-phase review (e.g., Codex loop then Claude cross-review). Never implements — planning only.

> Note: planner does NOT have `disallowedTools` because it needs Write/Edit to create and update plan files.

---

### init-project (Project Initialization Orchestrator)

**File**: `agents/init-project.md`

```yaml
---
name: init-project
description: "Project initialization orchestrator. Scans project, plans artifacts with reviewer verification, generates everything via ralph. NOT for planning (planner) or manual generation."
model: opus
---
```

**Role**: Orchestrates project initialization through a 4-phase pipeline: scan (detect stack, identify domains) → plan (spawn planner for verified artifact planning) → execute (spawn ralph for file generation) → report. Keeps deterministic generation rules (merge policy, globs detection, directory creation) and passes them to ralph.

> Note: init-project does NOT have `disallowedTools` because it needs to read files during the scan phase and may write intermediate results.

---

## Discuss Agents

Agents for the moderated multi-agent discussion system. These agents coordinate via the `dc` MCP server (`discuss_*` tools) and Agent Teams.

### discuss-lead (Discussion Moderator)

**File**: `agents/discuss-lead.md`

```yaml
---
name: discuss-lead
description: "Discussion moderator protocol for the teamlead. Controls turns, manages bidding loop, handles termination. Never speaks on substance."
model: opus
---
```

**Role**: Orchestrates multi-agent discussions through structured turn-taking. Manages session setup, team creation, bidding coordination, turn resolution, epoch transitions (auto-triggered by server), and synthesis delivery. Never speaks on substance — only process control.

**Protocol**: Setup (persona generation → `discuss({ op: "create", ... })` → team + teammates) → Discussion Loop (broadcast → discuss({ op: "wait", condition: "all_bids", ... }) → 4-way branch → discuss({ op: "wait", condition: "speech_delivered", ... }) → repeat) → Synthesis (`discuss({ op: "end", ... })` → full transcript → present to user → cleanup).

> Note: discuss-lead does NOT have `disallowedTools` — it needs Task (spawn agents), SendMessage (broadcast), TeamCreate/TeamDelete, and all discuss MCP tools.

---

### discussant (Discussion Participant)

**File**: `agents/discussant.md`

```yaml
---
name: discussant
description: "Discussion participant. Bids for speaking turns, researches evidence, delivers speeches via MCP discuss tools. Spawned as a teammate in Agent Teams."
model: sonnet
---
```

**Role**: Participates in discussions with a unique persona provided at spawn time. Follows the discuss({ op: "wait", condition: "action_needed", ... }) → act → loop cycle. Uses WebSearch for evidence gathering, reads transcript before speaking, and always notifies teamlead after speeches. Uses sonnet — the discussion protocol is well-defined, opus-level reasoning is unnecessary.

---

### persona-generator (Persona Creator)

**File**: `agents/persona-generator.md`

```yaml
---
name: persona-generator
description: "Generate a diverse, differentiated discussion persona based on role and topic. Spawned in parallel by discuss-lead."
model: opus
---
```

**Role**: Single-shot persona generator. Reads the template (`skills/discuss/template/persona-template.md`), generates a unique persona differentiated from team_roles, and outputs clean raw markdown. Uses opus for high-quality persona creation that requires creativity and specificity.

> Template: `skills/discuss/template/persona-template.md` defines the required structure (`# Name — Role`, 4 sections: Expertise, Perspective, Communication Style, Core Focus).

---

## Codex-bound Agents (Delegation Agents)

Proxy agents that delegate work to Codex CLI. Tool restrictions limit them to coral MCP tools only.

**Why one file?** All Codex delegation roles share ~60% identical protocol (Proxy_Protocol, Working_Directory, Session_Continuity, Output_Handling, Failure_Modes). A single file maximizes prompt cache hits — when architect + critic are spawned in parallel, their system prompts share an identical prefix, so only the first pays the full cost. New roles should be added here, not as separate agent files.

### codex-proxy (Unified Codex Delegation Proxy)

**File**: `agents/codex-proxy.md`

```yaml
---
name: codex-proxy
description: "Codex delegation proxy for analyst/architect/critic/ralph roles. Use when Codex-specific perspective is needed for analysis, review, critique, or execution."
model: sonnet
tools: mcp__plugin_coral_cx__codex_session_create, mcp__plugin_coral_cx__codex_session_send
---
```

**Role**: Single proxy agent with role-based routing. Callers include `Role: analyst|architect|critic|ralph` in their prompt to select the appropriate prompt template and settings. Missing role → explicit error (no inference).

| Role | Purpose | reasoning_effort |
|---|---|---|
| `analyst` | Root cause analysis, dependency tracing, technical investigation | xhigh |
| `architect` | Architecture review, design patterns, code structure | xhigh |
| `critic` | Plan/code critique, severity-rated verdicts (APPROVED/REVISE/REJECT) | xhigh |
| `ralph` | Single-shot task execution; Claude controls the outer verification loop | high |

> **Ralph note**: `codex-proxy` with `Role: ralph` executes one round. The caller (`/coral:codex-ralph` skill) controls the loop — spawning with the saved `thread_id` for session continuity until all criteria pass.

---

## Routing Guarantee (Triple Layer)

Three layers ensure Codex-bound agents always delegate to Codex CLI:

### Layer 1: Hook-based Injection (100% guarantee)

The `SubagentStart` hook fires when any agent matching `(^|:)codex-` starts (e.g., `codex-proxy`, `coral:codex-proxy`). It injects delegation instructions via `additionalContext`.

> Claude-native agents (`architect`, `critic`, `analyst`, `ralph`) lack the `codex-` prefix, so the hook never matches them.

### Layer 2: Tool Restriction (100% guarantee)

The `tools` field in Codex-bound agent definitions restricts them to coral MCP tools only.

> Claude-native agents have no `tools` restriction — they can use all read tools (`disallowedTools` only blocks writing). Ralph has no restrictions at all.

### Layer 3: System Prompt (99%+ guarantee)

Each agent `.md` file contains a detailed role and protocol embedded in the system prompt.

---

## Adding New Agents

### Codex-bound Agent (new role)

Add a new role to `agents/codex-proxy.md` under `<Role_Routing>` and `<Prompt_Templates>`. The existing `codex-proxy` agent handles all Codex delegation roles — callers pass `Role: <name>` in their prompt.

If a standalone Codex agent is truly needed (rare), create `agents/codex-<name>.md` — the `codex-` prefix ensures the hook fires automatically:

```yaml
---
name: codex-<name>
description: <description>
tools: mcp__plugin_coral_cx__codex_session_create, mcp__plugin_coral_cx__codex_session_send
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

### Claude-native Agent (Execution)

Create `agents/<name>.md` without `disallowedTools` for agents that need to write files:

```yaml
---
name: <name>
description: "<description>. Use when [trigger]. NOT for [exclusion]."
model: opus
---
```
