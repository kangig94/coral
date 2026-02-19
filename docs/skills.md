# Skills (Slash Commands)

Slash commands provided by the Coral plugin.

## /coral:codex

Execute a prompt directly with Codex CLI. Automatic persona detection dynamically loads architect/critic/analyze/ralph prompts.

**File**: `skills/codex/SKILL.md`

### Configuration

```yaml
---
name: codex
description: Execute a prompt with OpenAI Codex CLI
argument-hint: "[prompt]"
allowed-tools: mcp__cx__codex_execute, mcp__cx__codex_session_send, mcp__cx__codex_session_create
---
```

### Behavior

1. Check session continuity (existing thread_id → resume, new → execute)
2. Analyze intent → select persona (architect/critic/analyze/ralph/none)
3. If persona selected, dynamically load SYSTEM prompt from `agents/codex-*.md`
4. Enhance with conversation context (file paths, code snippets, working_directory)
5. Call Codex + display results

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

Persistent execution via Codex delegation. Delegates the execution loop to Codex CLI with session management.

**File**: `skills/codex-ralph/SKILL.md`

### Configuration

```yaml
---
name: codex-ralph
description: Persistent execution via Codex delegation — keeps working until done
argument-hint: "[task description]"
allowed-tools: mcp__cx__codex_execute, mcp__cx__codex_session_send, mcp__cx__codex_session_create
---
```

### Behavior

1. Load `agents/codex-ralph.md` protocol
2. Check session continuity (existing thread_id → resume, new → create session)
3. Construct prompt using `<Prompt_Template>` ([SYSTEM]/[CONTEXT]/[TASK])
4. Enhance with conversation context (file paths, progress, working_directory)
5. Call Codex with persistent verification — challenge unverified "done" claims
6. Pause after 5 rounds to confirm direction with user

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

1. Collect context + write initial plan to `.claude/coral/plans/` immediately
2. Review loop (max 5 rounds): parallel architect + critic → synthesize → update plan file → re-verify
3. Exit when no CRITICAL/HIGH findings remain
4. Present final plan (file already up to date)

---

## /coral:coplan

Collaborative planning with parallel Codex architect/critic reviews. Dynamically loads protocols from `agents/codex-architect.md` and `agents/codex-critic.md`.

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

1. Collect context + write initial plan to `.claude/coral/plans/` immediately
2. Codex review loop (max 5 rounds): parallel codex-architect + codex-critic → synthesize → update plan file → re-verify
3. Exit when no CRITICAL/HIGH findings remain
4. Claude-native final review (`coral:architect`, `coral:critic`) — cross-model gate
5. Present final plan (file already up to date)

---

## /coral:session

Manage Codex sessions. Supports 4 subcommands.

**File**: `skills/session/SKILL.md`

### Configuration

```yaml
---
name: session
description: Manage Codex conversation sessions
argument-hint: "[create|send|list|fork] [args...]"
allowed-tools: mcp__cx__codex_session_create, mcp__cx__codex_session_send,
               mcp__cx__codex_session_list, mcp__cx__codex_session_fork
---
```

### Subcommands

| Subcommand | Description |
|---|---|
| `create <name> <prompt>` | Create a named session |
| `send <name> <prompt>` | Send a follow-up message to an existing session |
| `list` | List registered sessions |
| `fork <name>` | Fork a session (resume-based) |

---

## /coral:init-project

Initialize a project for AI-assisted development. Generates `.claude/CLAUDE.md`, specialized agents, docs, settings, and KB directory — tailored to the project's domain.

**File**: `skills/init-project/SKILL.md`

### Configuration

```yaml
---
name: init-project
description: Initialize project for AI-assisted development with agents, CLAUDE.md, docs, and settings
argument-hint: "[existing|new]"
---
```

### Behavior

1. Detect scenario: existing project (scan source) or new project (conversation)
2. Identify domains — match against 9 Tier 1 categories or apply Tier 2 principle-based fallback
3. Load domain references (`references/*.md`) and templates (`templates/*.md`)
4. Generate artifacts with merge policy (skip existing agents, marker-based CLAUDE.md merge, deep-merge settings)
5. Report generated files

### Generated Artifacts

| Artifact | Always? | Description |
|---|---|---|
| `.claude/CLAUDE.md` | Yes | 6-section canonical structure with `<!-- CORAL:MANAGED -->` markers |
| `.claude/agents/review-orchestrator.md` | Yes | Final validation supervisor (tier 0, opus) |
| `.claude/agents/code-critic.md` | Yes | Code quality reviewer (tier 3, sonnet) |
| `.claude/agents/ux-critic.md` | Conditional | UX reviewer — frontend/mobile/plugin only |
| `.claude/agents/{domain}.md` | Yes | 3-5 domain-specific agents per detected domain |
| `.claude/agents/TEMPLATE.md` | Yes | Agent structure standard |
| `.claude/settings.local.json` | Yes | Build/test bash permissions |
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
