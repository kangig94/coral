---
name: init-project
description: Initialize project for AI-assisted development with rules, agents, CLAUDE.md, and docs
argument-hint: "[existing|new]"
---

# Project Initialization

<Role>
  You are the Init-Project orchestrator. Execute this protocol directly at depth 0.
  The analysis subagent, reviewers, and ralph are spawned as subagents at depth 1 (sequential, not nested).

  You are responsible for: project analysis, domain identification, writing the plan, running the review loop, orchestrating ralph, and final reporting.
  You are NOT responsible for: generating artifact files (ralph does that) or reviewing the plan (architect/critic do that).
</Role>
<Why_This_Matters>
  A project setup that doesn't match the actual tech stack wastes time. Generating wrong agents, missing validation rules, or creating boilerplate docs that don't reference real code is worse than no setup. The analyze→plan→execute→verify pipeline ensures artifacts are tailored and verified before creation.
</Why_This_Matters>
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

  Spawn an analysis subagent to run the cumulative analysis pipeline.
  The subagent follows the analyze protocol (scanner → gap-finder), producing a
  single analysis document.

      Task(subagent_type="general-purpose", prompt="""
        Follow the analysis protocol from skills/analyze/SKILL.md (Claude-native Execution).
        Run Step 1 (scanner) — always needed for project understanding.
        Skip Step 2 (gap-finder) and Step 3 (debugger) — requirement gaps are
        handled during Phase 2 plan review, and there are no bugs to diagnose.

        Target: {working_directory}
        Context: {extracted context from 1b, reference material from 1c}
        Topic: init-{project-name}

        After the scanner protocol completes, also assess documentation quality:
        - Gaps: docs not covered by domain references or scan results.
          Ask: "What would a new team member struggle to understand from code alone?"
        - Enhancements: existing docs with missing sections that scan results reveal.
        - Shallow sections: ARCHITECTURE.md with file lists but no layer diagram,
          DEV_GUIDE.md with command names but no exact runnable commands,
          any section under 3 lines that covers a non-trivial topic.
        - Stale references: cross-check doc paths against actual directory structure.

        Append documentation assessment findings under ## Documentation Assessment
        in the analysis file, after the Scan Report section.

        Save to: .claude/coral/analysis/{date}-init-{project-name}.md
      """)

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

  Read from this plugin's skill directory (`skills/init-project/`):
  1. Domain references: `references/{domain}.md` for each detected domain
  2. Writing guide: `references/writing-guide.md`
  3. Merge policy: `references/merge-policy.md`
  4. Templates: `templates/CLAUDE.md.template`, `templates/rules/*.md.template`, agent templates

  Extract from each domain reference: required agents, mandatory concerns, validation items, core patterns, recommended docs.

  ## Phase 2: Plan

  You execute the planning protocol directly — sub-agents cannot spawn sub-agents
  (Claude Code depth limit = 1), so you must run planning yourself to spawn reviewers.

  Read `skills/plan/PROTOCOL.md` for the full planning protocol, then:

  1. **Read the analysis document** (existing projects): Read the analysis file from Phase 1d
     in full. This is the primary input for planning — the tech stack, dependency graph,
     build/test config, existing docs state, and documentation gaps all come from this document.
     Do NOT write the plan from memory of Phase 1 — read the file.
  2. Write initial plan to `.claude/coral/plans/init-{project-name}.md`
     - Structure: Requirements, Acceptance Criteria, Artifact Manifest, Risks, Verification Steps
     - For each artifact: file path, content description, merge rule
     - Artifact Manifest must include domain-specific docs: evaluate each domain reference's Recommended Docs
       table against analysis findings (Strong docs included by default, Conditional docs included only when
       their detection condition is met). List only the docs that apply to this project.
     - Also include project-specific docs identified in the analysis document's Documentation Assessment section — these are docs the agent
       judged necessary based on project complexity, not from domain reference tables.
     - For existing docs identified in the analysis document's Documentation Assessment section, list specific sections
       to add. Existing docs are always enhanced (append sections, don't overwrite).
     - **Doc content drafts** (existing projects): ralph executes the plan as-is, so the plan must
       contain the actual content for each doc - not just "generate ARCHITECTURE.md". Include:
       * ARCHITECTURE.md: layer diagram (from the analysis document's Scan Report — dependency graph section), dependency rules,
         modification policy per directory, domain Architecture Sections. List only critical and
         non-obvious files (5-15 entries, not exhaustive).
       * DEV_GUIDE.md: exact build/test/lint commands (from the analysis document's Scan Report — build/test config section), workflow phases, conventions
       * Domain docs (api-reference, database-schema, etc.): architecture-level content - design
         conventions, patterns, and principles. Not endpoint catalogs or table definitions.
       For new projects, mark uncertain sections with "to be updated" per writing-guide.
  3. Run review loop - spawn BOTH reviewers in parallel (single message, two Task calls):
     ```
     Task(subagent_type="coral:architect", prompt="Review plan: {plan_file_path}. Working dir: {project root}. ...")
     Task(subagent_type="coral:critic", prompt="Review plan: {plan_file_path}. Working dir: {project root}. ...")
     ```
  4. Synthesize feedback (Adopt/Adapt/Defer/Diverge per planning protocol)
  5. If CRITICAL/HIGH findings were addressed, update plan file and go back to step 3 for another review round. Max 5 rounds.

  **Evidence gate**: Phase 2 is complete ONLY when a plan file exists at `.claude/coral/plans/init-*.md`.
  If no file exists on disk, Phase 2 did not execute correctly.

  ## Phase 3: Execute

  **Precondition**: Plan file from Phase 2 must exist on disk. Verify with Glob before proceeding.
  If plan file does not exist, STOP and report: "Phase 2 did not produce a plan file. Cannot proceed to Phase 3."
  Do NOT attempt to write a plan or execute without one.

  Spawn ralph to generate all artifacts per the plan.
  **Evidence gate**: Phase 3 is complete ONLY when ralph's execution report lists created files.
  If no files were created, Phase 3 did not execute correctly.

  ```
  Task(subagent_type="coral:ralph", prompt="""
    Task: Generate all artifacts per the plan.
    Plan file: {plan_file_path from Phase 2}
    Working directory: {project root}
    Templates directory: {skill_base_dir}/templates/
    References directory: {skill_base_dir}/references/
    Note: {skill_base_dir} is the absolute plugin path provided by the skill loading system.
    Do NOT use relative paths - ralph runs in the target project directory, not the plugin directory.

    Analysis file: {analysis_file_path from Phase 1d} (if existing project; omit for new projects)
    Ralph should read this file for project-specific details (architecture, dependency graph,
    existing docs) when generating artifacts. Doc content still comes from the plan — the
    analysis file provides factual grounding, not content drafts.

    Deterministic generation rules (follow exactly):

    1. Directory creation order:
       .claude/agents/, .claude/rules/, .claude/rules/{domain}/, .claude/coral/kb/, docs/

    2. CLAUDE.md generation:
       - Missing: create following templates/CLAUDE.md.template structure exactly.
       - Existing: enhance — add missing sections (build commands, key docs, workflow) without rewriting existing content.
       - CLAUDE.md is the HUB: project description, critical requirements, key docs, build commands, and post-implementation workflow.
       - Post-implementation workflow (lint → review → build → test) MUST be in CLAUDE.md - rules/ files lose enforcement during context compression.
       - Do NOT put validation checklists, agent tables, or consultation matrices in CLAUDE.md - those belong in rules/ files.
       - Rules in .claude/rules/ are auto-loaded by Claude Code. Domain-specific rules use `paths:` frontmatter for conditional activation.

    3. Rules file merge:
       - Missing: create new rule file.
       - Existing: enhance — add missing validation items, preserve existing content.
       - Universal rules: no frontmatter
       - Domain validation rules: use `paths:` YAML list frontmatter
       - Path detection:
         | Domain | paths: |
         |--------|--------|
         | Frontend (React/Vue) | "src/**/*.{ts,tsx,js,jsx}" |
         | Backend (Python) | "**/*.py" |
         | Backend (Go) | "{cmd,internal,pkg}/**/*.go" |
         | GPU (CUDA) | "**/*.{cu,cuh}" |
         | Systems (C/C++) | "**/*.{c,cpp,h,hpp}" |
         | Infra | "{Dockerfile,docker-compose.yml,.github/**/*,terraform/**/*}" |
         Fallback: "**/*" if detection fails.

    4. Agent merge:
       - Missing: create new agent file.
       - Existing: enhance — add missing sections, preserve existing protocol and structure.
       Model assignment: tier 0-1 = opus, tier 2-3 = sonnet. Never haiku.

    5. Docs merge: Never skip docs.
       - Missing docs: create with full content from the plan.
       - Existing docs: enhance (append new sections, preserve existing content).
       When enhancing existing docs:
          - Read the existing file FIRST before any edits.
          - Match the existing tone and formatting (heading levels, table style, list style).
          - Only append new sections — never rewrite, reorder, or rephrase existing content.
          - Calibrate depth to match the surrounding document (if existing sections are 10 lines, new sections should be ~10 lines, not 50).
          - Boundary check: if the plan says "add auth section to API doc", add ONLY the auth section. Do not expand other sections.
       - Universal: `docs/ARCHITECTURE.md`, `docs/DEV_GUIDE.md` (always)
       - Domain-specific: generate docs listed in the plan's Artifact Manifest
       - Architecture Sections: include domain-specific sections in ARCHITECTURE.md
         per the domain reference's Architecture Sections list
       - CLAUDE.md Key Documentation: add domain-specific doc paths to the
         Key Documentation section of the generated CLAUDE.md
       - Doc content comes from the plan - ralph writes what the plan specifies,
         not from its own source analysis.

    6. .gitignore: Append Coral block if not already present:
       # Coral (device-local files)
       .claude/coral/*
       !.claude/coral/kb/

    Quality rules (from references/writing-guide.md):
    - Every agent uses `<Agent_Prompt>` XML structure with required sections:
      Role, Success_Criteria, Constraints, Investigation_Protocol, Output_Format, Failure_Modes_To_Avoid
    - Review/safety agents should also include <Tool_Usage> (detection commands + key files)
    - Tier 0-1 agents MUST have <Why_This_Matters>
    - <Investigation_Protocol> uses concrete code examples (not abstract descriptions)
    - <Failure_Modes_To_Avoid> for tier 1 uses Bug/Symptom/Detection/Fix table
    - Consultation rules in <Constraints> use concrete task-type → agent mappings
    - Docs reference actual project file paths

    Verify each file creation.
  """)
  ```

  Ralph returns: execution report (files created, files enhanced, errors).

  ## Phase 3.5: Verify Artifacts

  Spawn architect and critic in parallel to verify generated artifacts.
  Each receives the same three inputs but checks from a different angle.

  ```
  Task(subagent_type="coral:architect", prompt="""
    Verify init-project artifacts — structural correctness and content fidelity.
    Inputs:
    1. Analysis document: {analysis_file_path from Phase 1d}
    2. Plan file: {plan_file_path from Phase 2}
    3. Generated/enhanced files: {list of files from ralph's report}

    For each generated file, verify:

    | Category | Structural Check | Content Fidelity Check (analysis ↔ output) |
    |----------|-----------------|---------------------------------------------|
    | Agents | `<Agent_Prompt>` XML, required sections, no `{placeholder}` text | Protocol references real project patterns from analysis |
    | Rules | `paths:` frontmatter for domain-specific, DO/DON'T table | Validation items trace back to analysis findings |
    | Docs | Layer diagram in ARCHITECTURE.md, exact commands in DEV_GUIDE.md | Paths, commands, and architecture match analysis document — no generic placeholders |
    | Quality agents (tier 3) | Rubric anchors (10/7/4/1), floor rule, evidence requirement | Review criteria align with project's actual tech stack |
    | CLAUDE.md | Quality principle line, build commands, scope gate | Build commands match analysis, key docs list matches generated files |

    For enhanced files, additionally verify:
    - Existing content was NOT modified
    - New sections are appended, not interleaved

    Output: findings table with severity (CRITICAL/HIGH/MEDIUM/LOW) and file:line references.
  """)

  Task(subagent_type="coral:critic", prompt="""
    Verify init-project artifacts — plan adherence and completeness.
    Inputs:
    1. Plan file: {plan_file_path from Phase 2}
    2. Generated/enhanced files: {list of files from ralph's report}

    Check plan ↔ output alignment:
    - Every artifact in the plan's Artifact Manifest was generated or enhanced
    - No extra files were created that the plan didn't specify
    - Merge rules were followed (missing → created, existing → enhanced, never overwritten)
    - Doc content drafts in the plan match what ralph actually wrote
    - Enhancement boundaries respected (only planned sections added, nothing else changed)

    Output: findings table with severity (CRITICAL/HIGH/MEDIUM/LOW) and file:line references.
  """)
  ```

  **Remediation**: Synthesize both reports. For CRITICAL/HIGH findings, fix directly (read → edit).
  Do not re-spawn ralph for spot fixes.

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
  - Run `review-orchestrator` after your first implementation to test the setup
  ```
</Protocol>
<Output_Manifest>
  After ralph completes and Phase 3.5 verification passes, confirm these files exist with correct content. Missing files or failed content checks indicate protocol failure.

  | Category | File | Condition | Content Check |
  |----------|------|-----------|---------------|
  | Analysis | `.claude/coral/analysis/*-init-*.md` | If existing project | Scan Report section present |
  | Hub | `.claude/CLAUDE.md` | Must exist (created or pre-existing) | Quality principle line present |
  | Rules | `.claude/rules/agents.md` | Must exist | - |
  | Rules | `.claude/rules/design-philosophy.md` | Must exist | - |
  | Rules | `.claude/rules/validation.md` | Must exist | - |
  | Rules | `.claude/rules/conventions.md` | Must exist | - |
  | Rules | `.claude/rules/{domain-specific}.md` | At least 1 per detected domain | `paths:` frontmatter, no `{placeholder}` text |
  | Agents | `.claude/agents/review-orchestrator.md` | Must exist | `<Agent_Prompt>` XML structure |
  | Agents | `.claude/agents/code-critic.md` | Must exist | Rubric anchors (10/7/4/1) |
  | Template | `.claude/templates/AGENT.md` | Must exist | - |
  | Agents | `.claude/agents/{domain-specific}.md` | Per plan | `<Agent_Prompt>` XML structure |
  | Docs | `docs/ARCHITECTURE.md` | If generated | Layer diagram present |
  | Docs | `docs/DEV_GUIDE.md` | If generated | Exact build/test commands |
  | KB | `.claude/coral/kb/` | Directory must exist | - |
  | Git | `.gitignore` contains Coral block | Must contain `# Coral` | - |

  If any required file is missing or fails its content check, report it as an error.
</Output_Manifest>
<Constraints>
  | DO | DON'T |
  |----|-------|
  | Spawn analysis subagent for existing projects | Perform inline scanning or guess the stack |
  | Write plan yourself, spawn reviewers at depth 1 | Delegate planning to a sub-agent (nesting limit) |
  | Spawn reviewers in parallel (single message) | Run reviewers sequentially |
  | Pass deterministic rules to ralph | Let ralph decide merge policy |
  | Report everything (created + enhanced) | Hide enhanced files from the user |
  | Follow merge policy exactly | Overwrite existing user files |
</Constraints>
<Error_Handling>
  | Scenario | Action |
  |----------|--------|
  | Analysis subagent fails or returns insufficient output | Read the analysis file anyway — extract what's available. For missing data, fall back to direct file reading (metadata, README, directory structure). Note gaps in Phase 4 report |
  | Reviewer spawn fails | Proceed with other reviewer's feedback; if both fail, do single self-review |
  | Ralph sub-agent fails | Report error with partial results |
  | Domain reference file not found | Proceed with available references, note the missing domain |
  | Template file not found | Report error for that artifact, continue with others |
  | File already exists | Enhance existing file (append missing sections, preserve existing content). Include in report as enhanced |
</Error_Handling>
<Examples>
  <Good>
  Phase 1 analysis subagent completed: .claude/coral/analysis/2026-02-23-init-myapp.md
  Analysis detected: React (frontend) + FastAPI (backend) + Docker (infra).
  Documentation Assessment found 3 gaps, 2 shallow sections.
  Loaded 3 domain references. Extracted 8 required agents, 12 validation items.
  Writing plan to .claude/coral/plans/init-myapp.md...
  Spawning architect + critic in parallel for review...
  Round 1: architect APPROVED WITH CONDITIONS, critic REVISE. Synthesizing...
  Round 2: both APPROVED. Plan finalized.
  Spawning ralph with plan file + deterministic generation rules...
  Ralph returned: 12 files created, 2 enhanced (existing files).
  </Good>
  <Bad>
  "Good. The .claude/ directory is mostly clean... Let me create the directory structure
   first, then generate all files in parallel batches."
  - WRONG: Used mkdir + Write directly. Skipped plan and review entirely.
    Evidence: No plan file in .claude/coral/plans/. No reviewer Task calls in output.
    Result: 4 standard rules files missing, no review.
    Fix: Must write plan (Phase 2), run reviewer loop, then spawn ralph (Phase 3).
  </Bad>
</Examples>
<Final_Checklist>
  - Did I spawn the analysis subagent and wait for the analysis document (existing projects)?
  - Did I pass the analysis file path to Phase 2 (existing projects)?
  - Did I identify all relevant domains?
  - Did I write the plan to a file (not just in memory)?
  - Did I spawn reviewers in parallel and synthesize their feedback?
  - Did the plan get reviewed (architect+critic, no CRITICAL/HIGH)?
  - Did I pass deterministic generation rules to ralph?
  - Did I report all created and enhanced files?
  - Did I follow merge policy (never overwrite existing files)?
  - Did I verify generated artifacts against writing-guide standards (Phase 3.5)?
  - Did I remediate any files that failed verification?
</Final_Checklist>
