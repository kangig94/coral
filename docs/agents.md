# Agents

Coral provides two types of agents:

- **Claude-native agents**: Claude Code performs analysis directly using its native tools. Default routing target.
- **Codex-bound agents**: Proxy agents that delegate work to Codex CLI. Used only on explicit request.

## Routing Rules

| User Request | Routing | Reason |
|---|---|---|
| "review with architect" | Claude-native (`architect`) | Default |
| "review with codex architect" | Codex-bound (`codex-architect`) | Explicit "codex" keyword |
| "review with critic" | Claude-native (`critic`) | Default |
| "review with codex critic" | Codex-bound (`codex-critic`) | Explicit "codex" keyword |
| "run ralph on this task" | Claude-native (`ralph`) | Default |
| "codex ralph this task" | Codex-bound (`codex-ralph`) | Explicit "codex" keyword |

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
model: opus
---
```

**Role**: Persistent task executor that loops until work is fully complete with verified evidence. Enforces the Iron Law: no completion claims without fresh verification evidence. Includes a verification gate (IDENTIFY → RUN → READ → VERIFY → CLAIM), iteration cap, and circuit breaker.

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

## Codex-bound Agents (Delegation Agents)

Proxy agents that delegate work to Codex CLI. Tool restrictions limit them to coral MCP tools only.

### codex-architect (Architecture Analysis Delegation)

**File**: `agents/codex-architect.md`

```yaml
---
name: codex-architect
description: "Architecture analysis via Codex delegation. Use when Codex-specific perspective is needed for design review, or when explicitly requested with 'codex architect'. NOT for direct Claude-native analysis (use architect agent instead)."
tools: mcp__plugin_coral_cx__codex_session_create, mcp__plugin_coral_cx__codex_session_send
---
```

**Role**: Constructs architecture analysis prompts with a canonical SYSTEM prompt and delegates to Codex.

---

### codex-critic (Critical Review Delegation)

**File**: `agents/codex-critic.md`

```yaml
---
name: codex-critic
description: "Critical review via Codex delegation. Use when Codex-specific perspective is needed for plan/code critique, or when explicitly requested with 'codex critic'. NOT for direct Claude-native critique (use critic agent instead)."
tools: mcp__plugin_coral_cx__codex_session_create, mcp__plugin_coral_cx__codex_session_send
---
```

**Role**: Delegates code and plan critique to Codex. Returns severity-rated verdicts (APPROVED/REVISE/REJECT).

---

### codex-analyst (Analysis Delegation)

**File**: `agents/codex-analyst.md`

```yaml
---
name: codex-analyst
description: "Deep analysis and investigation via Codex delegation. Use when Codex-specific perspective is needed for root cause analysis, dependency tracing, or technical investigation. NOT for direct Claude-native analysis (use analyst agent instead)."
tools: mcp__plugin_coral_cx__codex_session_create, mcp__plugin_coral_cx__codex_session_send
---
```

**Role**: Delegates technical analysis and investigation to Codex. Returns root cause, evidence trail, and file:line references.

---

### codex-ralph (Single-shot Codex Execution for Persistent Tasks)

**File**: `agents/codex-ralph.md`

```yaml
---
name: codex-ralph
description: "Single-shot Codex execution for persistent tasks. Claude controls the loop externally. NOT for Claude-native execution (use ralph agent instead)."
tools: mcp__plugin_coral_cx__codex_session_create, mcp__plugin_coral_cx__codex_session_send
---
```

**Role**: Executes a single round of work via Codex CLI. Claude (caller) controls the outer verification loop — spawning the agent repeatedly with thread_id for session continuity until all criteria pass.

---

## Routing Guarantee (Triple Layer)

Three layers ensure Codex-bound agents always delegate to Codex CLI:

### Layer 1: Hook-based Injection (100% guarantee)

The `SubagentStart` hook fires when any agent matching `(^|:)codex-` starts (e.g., `codex-architect`, `coral:codex-ralph`). It injects delegation instructions via `additionalContext`.

> Claude-native agents (`architect`, `critic`, `analyst`, `ralph`) lack the `codex-` prefix, so the hook never matches them.

### Layer 2: Tool Restriction (100% guarantee)

The `tools` field in Codex-bound agent definitions restricts them to coral MCP tools only.

> Claude-native agents have no `tools` restriction — they can use all read tools (`disallowedTools` only blocks writing). Ralph has no restrictions at all.

### Layer 3: System Prompt (99%+ guarantee)

Each agent `.md` file contains a detailed role and protocol embedded in the system prompt.

---

## Adding New Agents

### Codex-bound Agent

Create `agents/codex-<name>.md` — it automatically becomes a Codex delegation agent:

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
