---
name: init-project
description: "Use when setting up a new or existing project for AI-assisted development."
argument-hint: "[existing|new]"
---

> **CORAL_SKILLS**: `Bash("echo ~/.claude/plugins/cache/coral/coral/*/skills/")`

# Project Initialization

<Role>
  You are the Init-Project orchestrator. Execute this protocol directly at depth 0.
  The analysis subagent and reviewers are spawned as subagents at depth 1.

  Responsible for: project analysis, domain identification, writing the plan, running the review loop, generating artifacts (following ralph protocol directly), and final reporting.
  Not responsible for: reviewing the plan (architect/critic do that).
</Role>
<Protocol>
  ## Phase 1: Gather Context

  ### 1a. Detect Scenario

  Check the working directory for source files:

  **Existing project indicators** (any of these):
  - `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`
  - `src/`, `lib/`, `app/`, `csrc/`, `cmd/`
  - `Makefile`, `CMakeLists.txt`, `Dockerfile`
  - `README.md` with project description

  **New project**: Working directory is empty or has only basic scaffolding (e.g., `.git/` only).

  If ambiguous, treat as existing (safer).

  ### 1b. Extract Context

  Parse the command argument for:
  | Field | Examples |
  |-------|---------|
  | Project description | "a CLI tool for...", "REST API that..." |
  | Tech stack | "React + FastAPI", "Rust", "Next.js" |
  | Architectural concerns | "must be serverless", "multi-tenant" |
  | Reference material | "ref/codes", "github.com/...", "docs/spec.md" |

  **Existing projects**: Only ask for reference material if not provided.
  **New projects**: Ask only for unknown fields.

  ### 1c. Scan References

  If reference material provided, scan before project analysis:
  - Git repos: Read directory structure, README, key source files
  - URLs: Fetch and extract relevant patterns
  - Local files: Read and incorporate into domain analysis

  ### 1d. Analyze Project (existing only)

  ```
  Skill({ skill: "coral:analyze", args: "init-{project-name}:
    scan project structure, architecture, dependencies.
    Also assess documentation quality — documentation gaps,
    enhancements needed for existing docs, shallow sections
    (e.g., file lists without layer diagrams, commands without
    runnable examples, any section under 3 lines on non-trivial topics),
    and stale path references.
    Append under ## Documentation Assessment." })
  ```

  Context from 1b and 1c is already in conversation — analyze inherits it.

  Wait for the analysis document. Read it to extract:
  - Tech stack and primary languages
  - Architectural layers and dependency graph
  - Build/test configuration
  - Existing .claude/ and docs/ state
  - Documentation gaps, enhancements, and shallow sections

  ### 1e. Domain Identification

  For existing projects: read tech stack from the analysis document (1d).
  For new projects: use argument context (1b) and reference material (1c).
  Match the identified stack against domains:

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

  Multi-domain: generate the union of all relevant agents. Each domain gets its own validation rules.

  **Tier 2 fallback** (no Tier 1 match): Identify what a senior engineer would always check in review. Create agents by severity: data loss/security → tier 1 (opus), bugs → tier 2 (sonnet), code quality → tier 3 (sonnet).

  ### 1f. Load References

  Read from this plugin's skill directory (`CORAL_SKILLS/init-project/`):
  1. Domain references: `references/{domain}.md` for each detected domain
  2. Writing guide: `references/writing-guide.md`
  3. Merge policy: `references/merge-policy.md`
  4. Templates: `templates/CLAUDE.md.template`, `templates/rules/*.md.template`, `templates/agents/*.md` (fixed agents), `templates/agents/AGENT.md.template` (agent writing guide — internal use only, not copied to project), `templates/skills/tier-review/SKILL.md`

  Extract from each domain reference: required agents, mandatory concerns, validation items, core patterns, recommended docs.

  ## Phase 2: Plan

  Invoke the planning protocol via Skill expansion (inline, not a subagent — depth does
  not increase). You remain at depth 0 and can still spawn reviewers at depth 1.

  1. **Read analysis document** (existing projects): Read the analysis file from Phase 1d
     in full. This is the primary input for planning — the tech stack, dependency graph,
     build/test config, existing docs state, and documentation gaps all come from this document.
     Do NOT write the plan from memory of Phase 1 — read the file.
  2. **Follow planning protocol**: Invoke `Skill({ skill: "coral:plan", args: "--deep --no-handoff init-{project-name}" })`.
     - Plan name: `init-{project-name}`
     - Plan content requirements:
       * Structure: Requirements, Acceptance Criteria, Artifact Manifest, Risks, Verification Steps
       * For each artifact: file path, content description, merge rule
       * Artifact Manifest must include domain-specific docs: evaluate each domain reference's Recommended Docs
         table against analysis findings (Strong docs included by default, Conditional docs included only when
         their detection condition is met). List only the docs that apply to this project.
       * Also include project-specific docs identified in the analysis document's Documentation Assessment section — these are docs the agent
         judged necessary based on project complexity, not from domain reference tables.
       * For existing docs identified in the analysis document's Documentation Assessment section, list specific sections
         to add. Existing docs are always enhanced (append sections, don't overwrite).
       * **Doc content drafts** (existing projects): Phase 3 executes the plan as-is, so the plan must
         contain the actual content for each doc - not just "generate ARCHITECTURE.md". Include:
         - ARCHITECTURE.md: layer diagram (from the analysis document's Scan Report — dependency graph section), dependency rules,
           modification policy per directory, domain Architecture Sections. List only critical and
           non-obvious files (5-15 entries, not exhaustive).
         - DEV_GUIDE.md: exact build/test/lint commands (from the analysis document's Scan Report — build/test config section), workflow phases, conventions
         - Domain docs (api-reference, database-schema, etc.): architecture-level content - design
           conventions, patterns, and principles. Not endpoint catalogs or table definitions.
       * For new projects, mark uncertain sections with "to be updated" per writing-guide.

  **Evidence gate**: Phase 2 is complete ONLY when a plan file exists at `$CORAL_DATA/plans/init-*.md`.
  If no file exists on disk, Phase 2 did not execute correctly.

  ## Phase 3: Execute

  **Precondition**: Plan file from Phase 2 must exist on disk. Verify with Glob before proceeding.
  If plan file does not exist, STOP and report: "Phase 2 did not produce a plan file. Cannot proceed to Phase 3."
  Do NOT attempt to write a plan or execute without one.

  ### 3a. Staging Setup

  `.claude/rules/` is auto-loaded by Claude Code. Writing files there incrementally exposes
  partial state. Stage all `.claude/` files in a temp directory, then move atomically.

  **Staging directory**: `$TMPDIR/coral/<project-slug>/init-staging/`
  (`<project-slug>` = project dir path with `/` replaced by `-`, e.g. `-home-kang-workspace-myapp`)

  ```bash
  STAGING="$TMPDIR/coral/$(echo "$CLAUDE_PROJECT_DIR" | tr '/' '-')/init-staging"
  rm -rf "$STAGING" && mkdir -p "$STAGING"
  ```

  **Write rules**:
  - **All `.claude/` files** (new and enhanced): Write to `$STAGING/.claude/...`. For enhanced files, first `cp` the existing file into staging, then Edit there.
  - **`.kb/` files**: Write directly (project root, git-tracked)
  - **`$CORAL_DATA/` files**: Write directly (plugin data, not auto-loaded)
  - **`docs/` files** (new and enhanced): Write directly (not auto-loaded)

  ### 3b. Generate Artifacts

  Invoke `Skill({ skill: "coral:ralph", args: "execute the plan from Phase 2. Stage all .claude/ files (new and enhanced) under $STAGING/.claude/ instead of .claude/ directly. For enhanced files, cp the original into staging first, then Edit there." })`.
  Same pattern as Phase 2 — you execute at depth 0, spawning subagents at depth 1 as needed.

  You MUST read these reference files before generating any artifacts:
  - `{skill_base_dir}/references/merge-policy.md` — per-artifact merge rules (skip/create/enhance)
  - `{skill_base_dir}/references/writing-guide.md` — artifact quality standards

  Use `{skill_base_dir}/templates/` and `{skill_base_dir}/references/` for template and reference lookups.
  `{skill_base_dir}` is the absolute plugin path — do NOT use relative paths.
  The analysis file (from Phase 1d) provides factual grounding, not content drafts.
  Doc content comes from the plan — write what the plan specifies, not from your own analysis.

  Also write `$STAGING/.claude/skills/tier-review/SKILL.md` by copying from
  `{skill_base_dir}/templates/skills/tier-review/SKILL.md` — fixed artifact, not plan-dependent.

  ### 3c. Atomic Move

  After all files are generated, move staged `.claude/` files to their final location:

  ```bash
  cp -r "$STAGING/.claude/"* .claude/ && rm -rf "$STAGING"
  ```

  **Evidence gate**: Phase 3 is complete ONLY when generated files exist in their final locations.
  If no files were created, Phase 3 did not execute correctly.

  ## Phase 3.5: Verify Artifacts

  `Agent("coral:architect")` and `Agent("coral:critic")` in parallel to verify generated artifacts. Pass `--deep` in the prompt.
  Provide each with: plan file path, list of generated/enhanced files from Phase 3.
  Each outputs a findings table with severity (CRITICAL/HIGH/MEDIUM/LOW) and file:line references.

  **Architect** — structural correctness and content fidelity:
  - Read `{skill_base_dir}/references/writing-guide.md` for structural standards
  - Read analysis document for content fidelity check (analysis ↔ generated output)
  - Agents: `<Agent_Prompt>` XML with required sections, no `{placeholder}` text, protocols reference real project patterns
  - Rules: `paths:` frontmatter for domain-specific, validation items trace to analysis findings
  - Docs: layer diagram in ARCHITECTURE.md, exact commands in DEV_GUIDE.md, paths and architecture match analysis
  - CLAUDE.md: build commands match analysis, key docs list matches generated files
  - Enhanced files: existing content NOT modified, new sections appended only

  **Critic** — plan adherence and completeness:
  - Every artifact in the plan's Artifact Manifest was generated or enhanced
  - No extra files beyond what the plan specified
  - Merge rules followed (missing → created, existing → enhanced, never overwritten)
  - Doc content matches what the plan drafted
  - Enhancement boundaries respected (only planned sections added)

  **Remediation**: Synthesize both reports. For CRITICAL/HIGH findings, fix directly (read → edit).
  Fix spot issues directly (read → edit).

  **Evidence gate**: Phase 3.5 is complete when neither reviewer has unresolved CRITICAL/HIGH findings.

  ## Phase 4: Report

  Summarize:

  ```
  ## Init Complete

  ### Generated
  - {list of created files with brief descriptions}

  ### Enhanced (existing files)
  - {files that were enhanced with new sections}

  ### Note
  {If CLAUDE.md was enhanced: mention what was added vs preserved}

  ### Next Steps
  - Review generated rules in .claude/rules/ - customize for your project
  - Review .claude/CLAUDE.md - adjust project description and build commands
  - Invoke `Skill(tier-review)` after your first implementation to test the setup
  ```
</Protocol>
<Output_Manifest>
  After Phase 3 completes and Phase 3.5 verification passes, confirm these files exist with correct content. Missing files or failed content checks indicate protocol failure.

  | Category | File | Condition | Content Check |
  |----------|------|-----------|---------------|
  | Analysis | `$CORAL_DATA/analysis/*-init-*.md` | If existing project | Scan Report section present |
  | Hub | `.claude/CLAUDE.md` | Must exist (created or pre-existing) | Quality principle line present |
  | Rules | `.claude/rules/agents.md` | Must exist | - |
  | Rules | `.claude/rules/design-philosophy.md` | Must exist | - |
  | Rules | `.claude/rules/validation.md` | Must exist | - |
  | Rules | `.claude/rules/conventions.md` | Must exist | - |
  | Rules | `.claude/rules/{domain-specific}.md` | At least 1 per detected domain | `paths:` frontmatter, no `{placeholder}` text |
  | Agents | `.claude/agents/code-critic.md` | Must exist | Rubric anchors (10/7/4/1) |
  | Agents | `.claude/agents/doc-critic.md` | Must exist | Rubric anchors (10/7/4/1) |
  | Agents | `.claude/agents/test-critic.md` | Must exist | Rubric anchors (10/7/4/1) |
  | Template | `.claude/templates/AGENT.md` | Must NOT be created | Internal template — not deployed to user project |
  | Skills | `.claude/skills/tier-review/SKILL.md` | Must exist | `name: tier-review` in frontmatter |
  | Agents | `.claude/agents/{domain-specific}.md` | Per plan | `<Agent_Prompt>` XML structure |
  | Docs | `docs/ARCHITECTURE.md` | If generated | Layer diagram present |
  | Docs | `docs/DEV_GUIDE.md` | If generated | Exact build/test commands |
  | Docs | `docs/{domain-specific}.md` | Per domain reference Recommended Docs | Architecture-level content, not catalogs |
  | KB | `.kb/` | Directory must exist | - |
  | Git | `.gitignore` contains Coral block | Must contain `# Coral` | - |

  If any required file is missing or fails its content check, report it as an error.
</Output_Manifest>
<Constraints>
  | DO | DON'T |
  |----|-------|
  | Spawn analysis subagent for existing projects | Perform inline scanning or guess the stack |
  | Write plan yourself, spawn reviewers at depth 1 | Delegate planning to a sub-agent (nesting limit) |
  | Spawn reviewers in parallel (single message) | Run reviewers sequentially |
  | Read merge-policy.md and writing-guide.md before generating | Decide merge policy ad-hoc |
  | Report everything (created + enhanced) | Hide enhanced files from the user |
  | Follow merge policy exactly | Overwrite existing user files |
  | Execute phases in order (analyze→plan→execute→verify) | Skip to file generation without plan |
</Constraints>
<Error_Handling>
  | Scenario | Action |
  |----------|--------|
  | Analysis subagent fails or returns insufficient output | Read the analysis file anyway — extract what's available. For missing data, fall back to direct file reading (metadata, README, directory structure). Note gaps in Phase 4 report |
  | Reviewer spawn fails | Proceed with other reviewer's feedback; if both fail, do single self-review |
  | Phase 3 generation fails partway | Report error with partial results |
  | Domain reference file not found | Proceed with available references, note the missing domain |
  | Template file not found | Report error for that artifact, continue with others |
  | File already exists | Enhance existing file (append missing sections, preserve existing content). Include in report as enhanced |
</Error_Handling>
