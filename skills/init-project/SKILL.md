---
name: init-project
description: Initialize project for AI-assisted development with agents, CLAUDE.md, docs, and settings
argument-hint: "[existing|new]"
---

# Project Initialization

Set up a project for AI-assisted development. Generates `.claude/CLAUDE.md`, specialized agents, documentation, and configuration — tailored to the project's domain.

**Two scenarios**:
- **Existing project**: Scan source code, detect stack, generate setup based on analysis
- **New project**: Gather requirements through conversation, generate setup based on discussion

**Fully automatic**. Generate everything, then the user refines as needed.

---

## Step 1: Detect Scenario

Check the working directory for source files:

**Existing project indicators** (any of these):
- `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`
- `src/`, `lib/`, `app/`, `csrc/`, `cmd/`
- `Makefile`, `CMakeLists.txt`, `Dockerfile`
- `README.md` with project description

**New project**: Working directory is empty or has only basic scaffolding (e.g., `.git/` only).

If ambiguous, treat as existing (safer — scan won't hurt an empty project).

---

## Step 2: Extract Context & Gather Missing Info

### 2a. Extract from argument

Parse the command argument for any of these fields:

| Field | Examples |
|-------|---------|
| Project description | "a CLI tool for...", "REST API that..." |
| Tech stack | "React + FastAPI", "Rust", "Next.js" |
| Architectural concerns | "must be serverless", "multi-tenant" |
| Reference material | "ref/codes", "github.com/...", "docs/spec.md" |

Mark each field as **known** (found in argument) or **unknown** (not found).

### 2b. Ask only what's missing

**Existing projects**: The only field that cannot be inferred from code is **reference material**. If not already provided in the argument, ask:
- Any reference material to consider? (repos, docs, design specs, URLs — "none" is fine)

All other fields (description, stack, architecture) will be extracted from the codebase in step 2d.

**New projects**: Ask ONLY the fields marked **unknown** from step 2a. Skip any field already provided. If all fields are known, skip this step entirely.

Possible questions (only ask if unknown):
- What is this project? (1-2 sentences)
- Tech stack? (language, framework, key libraries)
- Key architectural concerns? (or "not sure yet" is fine)
- Any reference material? (repos, docs, design specs, URLs — "none" is fine)

### 2c. Scan references

If reference material was provided (from argument or conversation), scan before project analysis:
- **Git repos**: Read directory structure, README, key source files
- **URLs**: Fetch and extract relevant patterns
- **Local files**: Read and incorporate into domain analysis

### 2d. Scan project (existing projects only)

Read and analyze in this order:

1. **Project metadata**: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.
   - Extract: name, description, dependencies, scripts/commands, test framework
2. **README.md**: Project description, setup instructions, architecture notes
3. **Directory structure**: `ls -la` top level, then key subdirectories
   - Map directories to architectural layers
4. **Source file extensions**: Identify primary language(s)
5. **Import patterns**: Sample 3-5 source files to understand dependency directions
6. **Existing `.claude/`**: Check for existing agents, CLAUDE.md, settings — these will be merged
7. **Existing `docs/`**: Check what documentation already exists
8. **Build/test config**: Detect build tool, test framework, linter, formatter

---

## Step 3: Domain Identification

Match the detected or described stack against Tier 1 domains:

| Signal | Domain Reference |
|--------|-----------------|
| React, react-dom, Next.js, Vue, Svelte, Angular | `references/frontend.md` |
| Express, FastAPI, Django, Gin, Actix, Spring | `references/backend.md` |
| React Native, Flutter, SwiftUI, Jetpack Compose | `references/mobile.md` |
| obsidian, vscode, chrome extension, claude plugin | `references/plugin-extension.md` |
| Docker, Kubernetes, Terraform, GitHub Actions | `references/infra.md` |
| Spark, dbt, Airflow, ETL | `references/data.md` |
| PyTorch, TensorFlow, transformers, LLM, langchain | `references/ml-ai.md` |
| C/C++ (no GPU), CMake, RTOS, embedded | `references/systems.md` |
| CUDA, OptiX, Vulkan, Metal, GPU compute | `references/gpu.md` |

**Multi-domain**: A project can match multiple domains (e.g., Next.js + FastAPI + Docker). Generate the **union** of all relevant agents. The primary domain (most source code) sets the CLAUDE.md core structure.

**Tier 2 fallback**: If no Tier 1 match, apply this principle:

> Identify what a senior engineer in this domain would ALWAYS check in code review.
> For each critical concern: create a tier 1 agent (opus).
> For each domain concern: create a tier 2 agent (sonnet).
> For each quality concern: create a tier 3 agent (sonnet).
> Use the heuristic: "If a junior skipped this, what's the worst outcome?"
> Data loss / security breach / outage → tier 1. Bugs → tier 2. Messy code → tier 3.

---

## Step 4: Load References

Read the following files from this skill's directory:

1. **Domain references**: Read `references/{domain}.md` for each detected domain
2. **Writing guide**: Read `references/writing-guide.md` — quality patterns for agents and docs
3. **Merge policy**: Read `references/merge-policy.md` — how to handle existing files

Extract from each domain reference:
- Required agents (name, tier, model, purpose)
- Mandatory concerns for CLAUDE.md
- Validation checklist items
- Core patterns and anti-patterns

---

## Step 5: Load Templates

Read from this skill's `templates/` directory:

1. `templates/CLAUDE.md.template` — Canonical 6-section skeleton
2. `templates/review-orchestrator.md` — Always generate this agent
3. `templates/code-critic.md` — Always generate this agent
4. `templates/ux-critic.md` — Generate ONLY if frontend, mobile, or plugin domain detected
5. `templates/TEMPLATE.md` — Agent structure standard, copy to target project

---

## Step 6: Generate Artifacts

Apply merge policy from `references/merge-policy.md` for every artifact.

### 6.1 Create directories

```
.claude/agents/       (if not exists)
.claude/coral/kb/     (if not exists)
docs/                 (if not exists)
```

### 6.2 Generate .claude/CLAUDE.md

Use `templates/CLAUDE.md.template` as the skeleton. Fill placeholders with project-specific content:

- **Section 1 (Design Philosophy)**: Generate core principles from detected domain. Use domain reference's mandatory concerns as input.
- **Section 2 (Project Overview)**: From README scan or user conversation. Include detected build commands.
- **Section 3 (Agent System)**: Build quick reference table from ALL generated agents. Build consultation matrix from domain reference's agent-task mappings.
- **Section 4 (Workflow)**: Standard — references review-orchestrator as mandatory final step. Mentions `coral plan/coplan` integration.
- **Section 5 (Validation)**: Combine BLOCKING/STRONG/MINOR items from all domain references.
- **Section 6 (Conventions)**: Detect from config (prettier, eslint, black, rustfmt, etc.) or use sensible defaults.

**Merge rule**: If `.claude/CLAUDE.md` exists with numbered sections (`## 1.` through `## 6.`), replace content within each section. If exists without numbered sections, append missing sections. If not exists, create from scratch.

### 6.3 Generate standard agents

Copy from templates/ to `.claude/agents/`:
- `review-orchestrator.md` — always
- `code-critic.md` — always
- `ux-critic.md` — only if frontend/mobile/plugin detected
- `TEMPLATE.md` — always

**Merge rule**: Skip if same-name file already exists. Notify user.

### 6.4 Generate domain-specific agents

For each agent listed in the domain reference's "Required Agents" table:

1. Create `.claude/agents/{agent-name}.md`
2. Follow the structure from `templates/TEMPLATE.md`
3. Fill sections using the domain reference's patterns, anti-patterns, and checklist items
4. Set `model:` per tier matrix: tier 0-1 = opus, tier 2-3 = sonnet

**Merge rule**: Skip if same-name file already exists.

### 6.5 Generate .claude/settings.local.json

Detect build/test/lint commands from:
- `package.json` scripts → `Bash(npm run build)`, `Bash(npm test)`, etc.
- `Makefile` targets → `Bash(make build)`, `Bash(make test)`, etc.
- `pyproject.toml` scripts → `Bash(pytest)`, `Bash(python -m build)`, etc.
- `Cargo.toml` → `Bash(cargo build)`, `Bash(cargo test)`, etc.

Generate:
```json
{
  "permissions": {
    "allow": [
      "Bash(detected-build-command)",
      "Bash(detected-test-command)",
      "Bash(detected-lint-command)",
      "Bash(git *)"
    ]
  }
}
```

**Merge rule**: Deep-merge with existing. Add new entries, preserve existing, deduplicate.

### 6.6 Generate docs/ARCHITECTURE.md

For **existing projects**: Analyze scanned directory structure and import patterns. Write real architecture documentation with:
- Layer diagram (ASCII table mapping directories to layers)
- Dependency rules between layers
- Modification policy per directory
- Key files table

For **new projects**: Write initial structure based on discussion. Mark uncertain sections with "To be updated as architecture develops."

**Merge rule**: Skip if exists.

### 6.7 Generate docs/DEV_GUIDE.md

For **existing projects**: Document detected tooling:
- Build commands (from package.json, Makefile, etc.)
- Test commands and framework
- Linting/formatting tools
- Development workflow phases
- Code conventions

For **new projects**: Write based on discussed stack. Mark unverified with "To be confirmed."

**Merge rule**: Skip if exists.

### 6.8 Update .gitignore

Append if `# Coral` block not already present:

```
# Coral (device-local files)
.claude/coral/
!.claude/coral/kb/
```

---

## Step 7: Report

List all generated and modified files:

```
## Init Complete

### Generated
- .claude/CLAUDE.md (6 sections, {N} domain principles)
- .claude/agents/review-orchestrator.md
- .claude/agents/code-critic.md
- .claude/agents/{domain-agent-1}.md
- .claude/agents/{domain-agent-2}.md
- ...
- .claude/agents/TEMPLATE.md
- .claude/settings.local.json ({N} permissions)
- .claude/coral/kb/ (empty — grows via memo promotion)
- docs/ARCHITECTURE.md
- docs/DEV_GUIDE.md
- .gitignore (Coral block appended)

### Skipped (already existed)
- {file} — already exists, not overwritten

### Next Steps
- Review generated agents in .claude/agents/ — customize for your project
- Review .claude/CLAUDE.md — adjust principles and checklist items
- Run `review-orchestrator` after your first implementation to test the setup
```

---

## Model Assignment Matrix

When generating agent `.md` files, set the `model:` frontmatter field:

| Agent Tier | Model | Rationale |
|------------|-------|-----------|
| 0 (orchestration) | opus | Complex multi-agent coordination |
| 1 (safety) | opus | Critical domain concerns need deep reasoning |
| 2 (domain) | sonnet | Standard domain expertise |
| 3 (quality) | sonnet | Code review, UX checks |

Never default to haiku. Users can manually downgrade agents if desired.

---

## Quality Rules

Follow `references/writing-guide.md` for all generated content:

### Agents
- Every agent has ALL required sections from TEMPLATE.md
- Tier 1 agents MUST have Anti-Patterns table
- Core Patterns use concrete code examples (never abstract descriptions)
- Detection Commands are runnable bash commands

### Docs
- Reference actual project file paths (not generic placeholders)
- Use tables for structured information
- Include build/test commands exactly as detected
- For new projects, mark uncertain sections explicitly

### CLAUDE.md
- All 6 numbered sections present (`## 1.` through `## 6.`)
- No HTML comment markers — section headers are the identifiers
- Consultation matrix has concrete task-type → agent mappings
- Validation checklist items are actionable and verifiable
