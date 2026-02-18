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

1. Collect context + generate initial plan
2. Parallel Claude-native architect + critic review (using `agents/architect.md` and `agents/critic.md`)
3. Synthesize feedback (Adopt / Adapt / Defer / Diverge)
4. Display round summary + iterate (max 5 rounds)
5. Save final plan to `.claude/coral/plans/`

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
allowed-tools: mcp__cx__codex_execute, mcp__cx__codex_session_send
---
```

### Behavior

1. Collect context + generate initial plan
2. Parallel Codex architect + critic review (using `agents/codex-*.md` protocols)
3. Synthesize feedback (Adopt / Adapt / Defer / Diverge)
4. Display round summary + iterate (max 5 rounds)
5. Save final plan to `.claude/coral/plans/`

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
