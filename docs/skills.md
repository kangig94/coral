# Skills (Slash Commands)

Slash commands provided by the Coral plugin.

## /coral:codex

Route Codex requests to the appropriate agent, or manage Codex sessions directly. Single entry point for all Codex interactions.

**File**: `skills/codex/SKILL.md`

### Configuration

```yaml
---
name: codex
description: Execute a prompt with OpenAI Codex CLI
argument-hint: "[prompt]"
---
```

### Behavior

1. If argument starts with `session` → handle session command directly (create/send/list/fork via MCP tools)
2. Check session continuity (existing thread_id from conversation history)
3. Analyze intent → select agent subagent_type (architect/critic/analyze/ralph/delegate)
4. Gather context (file paths, code snippets, working_directory)
5. Spawn Task with selected `subagent_type` (`coral:codex-*`) + prompt
6. Present agent results

### Session Commands

| Command | Example |
|---|---|
| `session create <name> <prompt>` | `/coral:codex session create review analyze auth.ts` |
| `session send <name> <prompt>` | `/coral:codex session send review what about JWT?` |
| `session list` | `/coral:codex session list` |
| `session fork <name>` | `/coral:codex session fork review` |

---

## /coral:architect

Claude-native architecture analysis. Claude directly analyzes code using its native tools.

**File**: `skills/architect/SKILL.md`

### Configuration

```yaml
---
name: architect
description: Architecture review via Claude-native analysis
argument-hint: "[review target or question]"
---
```

### Behavior

1. Load `agents/architect.md` protocol
2. Execute Investigation_Protocol steps
3. Present severity-rated results using Output_Format
4. Deliver APPROVED / APPROVED WITH CONDITIONS / REJECT verdict

---

## /coral:critic

Claude-native plan/code critique. Verifies quality of plans and schema changes.

**File**: `skills/critic/SKILL.md`

### Configuration

```yaml
---
name: critic
description: Critical review of code or plans via Claude-native analysis
argument-hint: "[review target or question]"
---
```

### Behavior

1. Load `agents/critic.md` protocol
2. Execute Investigation_Protocol steps (file reference verification, implementation simulation)
3. Severity-rated findings (CRITICAL/HIGH/MEDIUM/LOW)
4. OKAY / REJECT verdict

---

## /coral:analyze

Claude-native deep analysis. Investigates requirements gaps, external constraints, and edge cases.

**File**: `skills/analyze/SKILL.md`

### Configuration

```yaml
---
name: analyze
description: Deep analysis and investigation via Claude-native analysis
argument-hint: "[investigation target or question]"
---
```

### Behavior

1. Load `agents/analyst.md` protocol
2. Execute Investigation_Protocol steps
3. Present findings by severity
4. Prioritized results (critical gaps first)

---

## /coral:ralph

Persistent execution loop with verification. Keeps working until done with evidence-based completion.

**File**: `skills/ralph/SKILL.md`

### Configuration

```yaml
---
name: ralph
description: Persistent execution loop with verification — keeps working until done
argument-hint: "[task description]"
---
```

### Behavior

1. Load `agents/ralph.md` protocol
2. Apply the Iron Law: NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
3. Execute the task following Investigation_Protocol steps
4. Verification Gate before any completion claim:
   - IDENTIFY what command proves the claim
   - RUN the command (fresh, complete)
   - READ the output, check exit code
   - VERIFY the output confirms the claim
   - ONLY THEN make the claim
5. Request architect verification before declaring task complete

---

## /coral:codex-ralph

Persistent execution via Codex with Claude-controlled verification loop. Claude orchestrates; Codex executes each round.

**File**: `skills/codex-ralph/SKILL.md`

### Configuration

```yaml
---
name: codex-ralph
description: Persistent execution via Codex delegation — keeps working until done
argument-hint: "[task description]"
---
```

### Behavior

1. Gather context (task description, file paths, progress, working_directory)
2. Claude-controlled loop (up to 5 rounds):
   - Spawn `coral:codex-ralph` agent with task + thread_id (session continuity)
   - Claude verifies changes (read files, run tests, compare against criteria)
   - If not complete → re-spawn with updated progress context
3. Post-completion review: read every changed file, compare against requirements, fix discrepancies

---

## /coral:plan

Claude-native planning with parallel architect/critic self-review. Uses `coral:architect` and `coral:critic` Task agents.

**File**: `skills/plan/SKILL.md`

### Configuration

```yaml
---
name: plan
description: Claude-native planning with parallel architect/critic self-review
argument-hint: "[task description]"
---
```

### Behavior

1. Load `agents/planner.md` protocol
2. Configure reviewers: `coral:architect` and `coral:critic` (full review loop, up to 5 rounds)
3. Execute planner protocol (gather context, write plan, review loop until no CRITICAL/HIGH, completion)
4. Present final plan to the user

---

## /coral:coplan

Collaborative planning with parallel Codex architect/critic reviews, followed by Claude cross-review.

**File**: `skills/coplan/SKILL.md`

### Configuration

```yaml
---
name: coplan
description: Collaborative planning with parallel Codex architect/critic reviews
argument-hint: "[task description]"
---
```

### Behavior

1. Load `agents/planner.md` protocol
2. Configure multi-phase review:
   - Phase 1 reviewers: `coral:codex-architect` and `coral:codex-critic` (full review loop, up to 5 rounds)
   - Phase 2 cross-reviewers: `coral:architect` and `coral:critic` (single verification pass + one retry)
3. Execute planner protocol with multi-phase review
4. Present final plan to the user

---

## /coral:init-project

Initialize a project for AI-assisted development. Generates `.claude/CLAUDE.md` (slim hub), `.claude/rules/` (modular rules), specialized agents, docs, settings, and KB directory — tailored to the project's domain.

**File**: `skills/init-project/SKILL.md`

### Configuration

```yaml
---
name: init-project
description: Initialize project for AI-assisted development with rules, agents, CLAUDE.md, docs, and settings
argument-hint: "[existing|new]"
---
```

### Behavior

1. Load `agents/init-project.md` protocol
2. Execute orchestration phases:
   - **Scan**: Detect scenario, identify domains, load references
   - **Plan**: Spawn planner agent for verified artifact planning (architect+critic review)
   - **Execute**: Spawn ralph agent for file generation with deterministic merge rules
   - **Report**: Summarize generated and skipped files
3. Present final report to the user

### Generated Artifacts

| Artifact | Always? | Description |
|---|---|---|
| `.claude/CLAUDE.md` | Yes | Slim hub: project overview + build commands |
| `.claude/rules/design-philosophy.md` | Yes | Core principles, source tree policy, agent philosophy |
| `.claude/rules/agents.md` | Yes | Agent quick reference table + consultation matrix |
| `.claude/rules/workflow.md` | Yes | Development workflow + review gate |
| `.claude/rules/conventions.md` | Yes | Commits, naming, tests, formatting |
| `.claude/rules/{domain}/validation.md` | Yes | Domain validation checklist with `paths:` frontmatter |
| `.claude/agents/review-orchestrator.md` | Yes | Final validation supervisor (tier 0, opus) |
| `.claude/agents/code-critic.md` | Yes | Code quality reviewer (tier 3, sonnet) |
| `.claude/agents/ux-critic.md` | Conditional | UX reviewer — frontend/mobile/plugin only |
| `.claude/agents/{domain}.md` | Yes | 3-5 domain-specific agents per detected domain |
| `.claude/agents/TEMPLATE.md` | Yes | Agent structure standard |
| `.claude/coral/kb/` | Yes | Empty KB directory |
| `docs/ARCHITECTURE.md` | Yes | Real architecture documentation |
| `docs/DEV_GUIDE.md` | Yes | Real development guide |
| `.gitignore` | Append | Coral device-local file rules |

### Supported Domains (Tier 1)

| Category | Domains |
|---|---|
| Frontend | React, Vue, Svelte, Next.js, Angular |
| Backend | Node.js/Express, Python/FastAPI/Django, Go, Rust, Java/Spring |
| Mobile | React Native, Flutter, iOS/Swift, Android/Kotlin |
| Plugin/Extension | VSCode, Chrome Extension, Obsidian, Claude Code Plugin |
| Infra | Docker/K8s, Terraform, CI/CD |
| Data | Spark, dbt, ETL pipelines |
| ML/AI | PyTorch, TensorFlow, LLM Application |
| Systems | C/C++, Embedded/RTOS |
| GPU | CUDA/OptiX, Vulkan/Metal |

---

## /coral:statusline

Install or remove the coral HUD statusline for Claude Code.

**File**: `skills/statusline/SKILL.md`

### Configuration

```yaml
---
name: statusline
description: Install or remove coral HUD statusline
argument-hint: "[install|uninstall]"
---
```

### Behavior

1. **install**: Write HUD script to `~/.claude/hud/coral-hud.mjs`, configure `statusLine` in `~/.claude/settings.json`
2. **uninstall**: Remove `statusLine` from settings, delete HUD script and cache

### HUD Elements

| Element | Source | Description |
|---|---|---|
| Model | stdin JSON | Current model name |
| Session | stdin JSON | Session duration |
| Rate limits | OAuth API | 5-hour and weekly usage (color-coded: green/yellow/red) |
| Context | stdin JSON | Context window usage percentage (color-coded) |
