---
name: init-project
description: "Use when setting up a new or existing project for AI-assisted development."
argument-hint: "[existing|new]"
---

# Project Initialization

<Role>
  You are the Init-Project orchestrator. Execute this protocol directly at depth 0.
  The scanner and reviewers are spawned as subagents at depth 1.

  Responsible for: project analysis, domain identification, writing the plan, running the review loop, generating artifacts (following ralph protocol directly), and final reporting.
  Not responsible for: reviewing the plan (architect/critic do that).

  **Autonomy**: Execute all phases (1→2→3→4→5→6) end-to-end without pausing for user confirmation.
  Evidence gates are self-checks, not user approval points. Do not ask "shall I continue?" between phases.
</Role>
<Execution_Discipline>
  Work conventions that guard failure modes which recur in this protocol. They bind across
  all phases — treat each as a precondition, not advice. Governing principle: **setup work is
  verified to the same bar as feature code — confirm against the authoritative source (the
  templates), never declare "sufficient" from memory or a partial scan.**

  1. **Full-tree discovery before any "missing" conclusion.** Never decide a template or
     reference is absent from a depth-limited or filtered listing. Run
     `find {skill_base_dir}/templates -type f` (no `-maxdepth`, no `grep` pre-filter) once and
     treat that inventory as authoritative. The "template not found" fallback may fire only
     after a full listing confirms absence.

  2. **Fixed artifacts are copied, never authored from memory.** Every artifact the protocol
     calls fixed — `templates/skills/tier-review/SKILL.md`, `templates/agents/{code,doc,test,ux}-critic.md` —
     is produced by: read the template file → copy it → graft only project-specific hooks. Do
     not reconstruct it from another repo's output or recollection; you will drop required sections.

  3. **Read every template in full; obey directives in its body.** Templates contain
     instructions, not only `{placeholders}` (e.g. tier-review's "add coral:architect to the list
     with tier 1 by default"). Read the whole file before instantiating and treat its imperative
     sentences as requirements.

  4. **Diff-against-template is part of Phase 4.** Verification asserts each generated fixed
     artifact contains every section and directive its template has — a structural diff, not a
     frontmatter-key existence check. "name: present" does not catch a dropped section.

  5. **Enumerate concerns before writing agents; one agent per concern; justify omissions.**
     In the Tier-2 fallback, first produce an explicit `concern → severity → agent` table for the
     domain. Give each distinct failure mode its own agent — do not bundle several into one
     guardian — and record in `agents.md` why any plausible agent was deliberately NOT created
     (covered-by-X), so the roster is a justified decision, not an accident.

  6. **Tier discipline is explicit.** Tier-1/2 safety guardians are binary gates
     (PASS / NEEDS WORK on BLOCKING findings, no rubric); Tier-3 quality agents are rubric-scored.
     A guardian without a score and a critic with one are both correct — do not "fix" either
     toward the other.
</Execution_Discipline>
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

  Spawn a scanner subagent to protect the main context window from heavy file I/O.

  1. **Create analysis file**: Write `CORAL_PROJECT/analysis/{YYYY-MM-DD}-init-{project-name}.md`:
     ```markdown
     # Analysis: init-{project-name}
     Date: {YYYY-MM-DD}
     Question: Scan project structure, architecture, dependencies. Assess documentation quality.
     ```

  2. **Spawn scanner**:
     ```
     Agent({ subagent_type: "coral:scanner",
       prompt: "Scan this project for init-project setup.
         Scope: project structure, architecture, dependencies, build/test config.
         Also assess documentation quality — gaps, enhancements needed, shallow sections
         (file lists without layer diagrams, commands without runnable examples,
         any section under 3 lines on non-trivial topics), stale path references.
         Focus on: source tree vs .claude/rules, agent definitions vs codebase modules,
         CLAUDE.md accuracy, docs/ freshness, new modules/patterns not captured in rules.
         {include summary of 1b/1c context if available}
         Output a structured scan report." })
     ```

  3. **Write findings**: Append the scanner's output to the analysis file under `## Scan Report`.
     Add a `## Documentation Assessment` section summarizing doc gaps and stale content.

  Read the completed analysis file to extract:
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
  2. **Follow planning protocol**: Invoke `Skill({ skill: "coral:plan", args: "round=1 --no-handoff init-{project-name}" })`.
     - Plan name: `init-{project-name}`
     - Plan content requirements:
       * Structure: Requirements, Acceptance Criteria, Artifact Manifest, Risks, Verification Steps
       * For each artifact: file path, content description, merge rule (create/skip/enhance/update)
       * Artifact Manifest must include domain-specific docs: evaluate each domain reference's Recommended Docs
         table against analysis findings (Strong docs included by default, Conditional docs included only when
         their detection condition is met). List only the docs that apply to this project.
       * Also include project-specific docs identified in the analysis document's Documentation Assessment section — these are docs the agent
         judged necessary based on project complexity, not from domain reference tables.
       * For existing files identified as stale in the analysis document, use merge rule "update" with
         specific change descriptions (what's stale, what's correct, which analysis finding).
       * For existing docs needing new sections, use merge rule "enhance" (append sections, don't modify existing).
       * **Doc content drafts** (existing projects): Phase 3 executes the plan as-is, so the plan must
         contain the actual content for each doc - not just "generate ARCHITECTURE.md". Include:
         - ARCHITECTURE.md: layer diagram (from the analysis document's Scan Report — dependency graph section), dependency rules,
           modification policy per directory, domain Architecture Sections. Directory tree: key files only
           (5-15 entries, not exhaustive). Dependency graph: layer-level, not per-file imports.
         - Module docs (core-modules.md): role tables by component — `module | responsibility` rows,
           not per-file sections with export catalogs. See writing-guide Module Doc Requirements.
         - DEV_GUIDE.md: exact build/test/lint commands (from the analysis document's Scan Report — build/test config section), workflow phases, conventions
         - Domain docs (api-reference, database-schema, etc.): architecture-level content - design
           conventions, patterns, and principles. Not endpoint catalogs or table definitions.
         - **Staleness test for all docs**: if content needs updating when a file is renamed or an import changes, it belongs in source code (JSDoc), not docs.
       * For new projects, mark uncertain sections with "to be updated" per writing-guide.

  **Evidence gate**: Phase 2 is complete ONLY when a plan file exists at `CORAL_PROJECT/plans/init-*.md`.
  If no file exists on disk, Phase 2 did not execute correctly.

  ## Phase 3: Execute

  **Precondition**: Plan file from Phase 2 must exist on disk. Verify with Glob before proceeding.
  If plan file does not exist, STOP and report: "Phase 2 did not produce a plan file. Cannot proceed to Phase 3."
  Do NOT attempt to write a plan or execute without one.

  ### 3a. Staging Setup

  `.claude/rules/` is auto-loaded by Claude Code. Writing files there incrementally exposes
  partial state. Stage all `.claude/` files in a temp directory, then move atomically.

  **Staging directory**: `CORAL_PROJECT/init-staging/`
  Already outside the project tree (`~/.coral/projects/{slug}/`), no platform-specific temp dir needed.

  ```bash
  STAGING="CORAL_PROJECT/init-staging"
  rm -rf "$STAGING" && mkdir -p "$STAGING"
  ```

  **Write rules**:
  - **All `.claude/` files** (new, enhanced, and updated): Write to `$STAGING/dot-claude/...`. For enhanced/updated files, first `cp` the existing file into staging, then Edit there.
  - **`CORAL_PROJECT/` working files** (plans, analysis): Write directly (not auto-loaded)
  - **`docs/` files** (new, enhanced, and updated): Write directly (not auto-loaded)

  ### 3b. Generate Artifacts

  Invoke `Skill({ skill: "coral:ralph", args: "execute the plan from Phase 2. Stage all .claude/ files (new, enhanced, and updated) under $STAGING/dot-claude/ instead of .claude/ directly. For enhanced/updated files, cp the original into staging first, then Edit there." })`.
  Same pattern as Phase 2 — you execute at depth 0, spawning subagents at depth 1 as needed.

  You MUST read these reference files before generating any artifacts:
  - `{skill_base_dir}/references/merge-policy.md` — per-artifact merge rules (skip/create/enhance/update)
  - `{skill_base_dir}/references/writing-guide.md` — artifact quality standards

  Use `{skill_base_dir}/templates/` and `{skill_base_dir}/references/` for template and reference lookups.
  `{skill_base_dir}` is the absolute plugin path — do NOT use relative paths.
  The analysis file (from Phase 1d) provides factual grounding, not content drafts.
  Doc content comes from the plan — write what the plan specifies, not from your own analysis.

  Also write `$STAGING/dot-claude/skills/tier-review/SKILL.md` by copying from
  `{skill_base_dir}/templates/skills/tier-review/SKILL.md` — fixed artifact, not plan-dependent.

  **Evidence gate**: Phase 3 is complete ONLY when all artifacts exist in staging (`$STAGING/dot-claude/`)
  and directly-written locations (`docs/`). Do NOT move staged files yet — verification comes first.

  ## Phase 4: Verify Artifacts

  **Verify BEFORE moving to final locations.** `.claude/rules/` is auto-loaded — placing
  unverified files there exposes partial or incorrect state to Claude Code.

  `Agent("coral:architect")` and `Agent("coral:critic")` in parallel to verify generated artifacts. Pass `--deep` in the prompt.
  Include in each spawn prompt: "Review is read-only. NEVER run `git checkout`, `git switch`, `git stash`,
  `git reset`, `git restore`, or `git clean`, and never stage or commit — you share this working tree
  with parallel reviewers and staged Phase 3 artifacts. To inspect another revision, use `git diff <ref>`,
  `git show <ref>:<path>`, or `git log <ref>` — never check it out."
  Provide each with: plan file path, list of generated/enhanced/updated files from Phase 3.
  For `.claude/` files, point reviewers to the **staging paths** (`$STAGING/dot-claude/...`).
  For `docs/` files, point to their actual paths (written directly in Phase 3b).
  Each outputs a findings table with severity (CRITICAL/HIGH/MEDIUM/LOW) and file:line references.

  **Architect** — structural correctness and content fidelity:
  - Read `{skill_base_dir}/references/writing-guide.md` for structural standards
  - Read analysis document for content fidelity check (analysis ↔ generated output)
  - Agents: `<Agent_Prompt>` XML with required sections, no `{placeholder}` text, protocols reference real project patterns
  - Rules: `paths:` frontmatter for domain-specific, validation items trace to analysis findings
  - Docs: layer diagram in ARCHITECTURE.md, exact commands in DEV_GUIDE.md, paths and architecture match analysis
  - Docs staleness surface: flag per-file catalogs, exhaustive directory trees (>15 entries),
    import dependency graphs, redundant "See src/" pointers. Module docs must use role tables, not per-file sections.
  - CLAUDE.md: build commands match analysis, key docs list matches generated files
  - Enhanced files: existing content NOT modified, new sections appended only
  - Updated files: only cited stale content changed, all other content preserved

  **Critic** — plan adherence and completeness:
  - Every artifact in the plan's Artifact Manifest was generated, enhanced, or updated
  - No extra files beyond what the plan specified
  - Merge rules followed (missing → created, existing → enhanced or updated per plan, never overwritten)
  - Doc content matches what the plan drafted
  - Enhancement boundaries respected (only planned sections added)
  - Update boundaries respected (only cited stale content changed, all else preserved)

  **Remediation**: Synthesize both reports. For CRITICAL/HIGH findings, fix directly (read → edit).
  Fix `.claude/` files in staging, `docs/` files in place.

  **Evidence gate**: Phase 4 is complete when neither reviewer has unresolved CRITICAL/HIGH findings.

  ## Phase 5: Apply

  **Only after Phase 4 passes**, move staged files to their final location:

  ```bash
  cp -r "$STAGING/dot-claude/"* .claude/ && rm -rf "$STAGING"
  ```

  Then run Coral's shared project-ignore maintainer. It preflights the complete change,
  writes the anchored `.git/info/exclude` entry, creates or reuses the symlink, and then
  retracts Coral-owned scoped and Git-root lines. This is the same bounded, atomic
  implementation used by SessionStart; do not reimplement these mutations with shell
  text processing.

  ```bash
  CORAL_PROJECT_IGNORE_SCRIPT="{skill_base_dir}/../../hooks/project-ignore.mjs"
  CORAL_PROJECT_IGNORE_OWNER="{skill_base_dir}/../../hooks/project-ignore-owner.mjs"
  CORAL_PROJECT_IGNORE_STATUS=0
  CORAL_PROJECT_IGNORE_RESULT="$(
    node "$CORAL_PROJECT_IGNORE_OWNER" --project-dir "$PWD" --create-symlink
  )" || CORAL_PROJECT_IGNORE_STATUS=$?
  if [ "$CORAL_PROJECT_IGNORE_STATUS" -eq 75 ]; then
    echo "CORAL_PROJECT_IGNORE_OUTCOME=maintenance-busy" >&2
    echo "Another Coral project-ignore maintainer owns the lock. Wait for it to finish, or terminate it if it is stuck, then retry." >&2
    exit 1
  fi
  if [ "$CORAL_PROJECT_IGNORE_STATUS" -ne 0 ] && [ -z "$CORAL_PROJECT_IGNORE_RESULT" ]; then
    echo "CORAL_PROJECT_IGNORE_OUTCOME=maintenance-lock-unavailable" >&2
    echo "Coral project-ignore setup could not open the maintenance lock or launch its owner. Ensure ~/.coral/staging is writable and flock is executable, then retry." >&2
    exit 1
  fi
  if ! printf '%s\n' "$CORAL_PROJECT_IGNORE_RESULT" | node "$CORAL_PROJECT_IGNORE_SCRIPT" --validate-result; then
    echo "CORAL_PROJECT_IGNORE_OUTCOME=unparseable-output" >&2
    echo "Coral project-ignore setup returned malformed result data. Retry init-project; if it recurs, report the captured result as a Coral defect." >&2
    exit 1
  fi
  case "$CORAL_PROJECT_IGNORE_RESULT" in
    *'"status":"complete"'*) CORAL_PROJECT_IGNORE_RESULT_STATUS=complete; CORAL_PROJECT_IGNORE_EXPECTED_STATUS=0 ;;
    *'"status":"partial"'*) CORAL_PROJECT_IGNORE_RESULT_STATUS=partial; CORAL_PROJECT_IGNORE_EXPECTED_STATUS=1 ;;
    *'"status":"refused"'*) CORAL_PROJECT_IGNORE_RESULT_STATUS=refused; CORAL_PROJECT_IGNORE_EXPECTED_STATUS=1 ;;
    *)
      echo "CORAL_PROJECT_IGNORE_OUTCOME=unparseable-output" >&2
      echo "Coral project-ignore setup returned an unreadable result. Inspect the reported JSON and retry." >&2
      exit 1
      ;;
  esac
  if [ "$CORAL_PROJECT_IGNORE_STATUS" -ne "$CORAL_PROJECT_IGNORE_EXPECTED_STATUS" ]; then
    echo "CORAL_PROJECT_IGNORE_OUTCOME=unparseable-output" >&2
    echo "Coral project-ignore setup returned a result inconsistent with its process status. Retry init-project; if it recurs, report both values as a Coral defect." >&2
    exit 1
  fi
  if [ "$CORAL_PROJECT_IGNORE_RESULT_STATUS" = partial ]; then
    echo "CORAL_PROJECT_IGNORE_OUTCOME=partial" >&2
    printf 'CORAL_PROJECT_IGNORE_RESULT=%s\n' "$CORAL_PROJECT_IGNORE_RESULT" >&2
    echo "Coral project-ignore setup changed at least one artifact, then another artifact refused. Inspect CORAL_PROJECT_IGNORE_RESULT, apply its named remedy, then rerun init-project." >&2
    exit 1
  fi
  if [ "$CORAL_PROJECT_IGNORE_RESULT_STATUS" = refused ]; then
    echo "CORAL_PROJECT_IGNORE_OUTCOME=refused" >&2
    printf 'CORAL_PROJECT_IGNORE_RESULT=%s\n' "$CORAL_PROJECT_IGNORE_RESULT" >&2
    echo "Coral project-ignore setup refused before making progress. Inspect CORAL_PROJECT_IGNORE_RESULT, apply its named remedy, then rerun init-project." >&2
    exit 1
  fi
  if [ "$CORAL_PROJECT_IGNORE_STATUS" -ne 0 ]; then
    echo "Coral project-ignore setup reported complete with an inconsistent process exit. Inspect CORAL_PROJECT_IGNORE_RESULT and retry." >&2
    exit 1
  fi
  ```

  Keep `CORAL_PROJECT_IGNORE_RESULT` for the Phase 6 report. A successful result
  confirms that `.git/info/exclude` carries Coral's anchored project-relative symlink
  entry and that the Coral-owned standalone `coral` line was retracted from
  `.claude/.gitignore`. Coral no longer owns or adds any scoped ignore line, including
  `*.coral-*.tmp`; the manifest verifies their absence. A partial result records changes
  that already happened; report them from the artifact dispositions instead of
  describing the run as refused.

  ## Phase 6: Report

  Summarize:

  ```
  ## Init Complete

  ### Generated
  - {list of created files with brief descriptions}

  ### Enhanced (existing files)
  - {files that were enhanced with new sections}

  ### Updated (stale content corrected)
  - {files with targeted edits, what was changed and why}
  - {report the project-ignore migration result by status and artifact disposition:
    anchored `.git/info/exclude` entry, removed Coral-owned scoped and Git-root lines
    when present, and created/reused `.claude/coral`}

  ### Note
  {If CLAUDE.md was enhanced/updated: mention what was added/changed vs preserved}

  ### Next Steps
  - Review generated rules in .claude/rules/ - customize for your project
  - Review .claude/CLAUDE.md - adjust project description and build commands
  - Invoke `Skill(tier-review)` after your first implementation to test the setup
  ```
</Protocol>
<Output_Manifest>
  After Phase 5 (Apply) completes, confirm these files exist with correct content. Missing files or failed content checks indicate protocol failure.

  | Category | File | Condition | Content Check |
  |----------|------|-----------|---------------|
  | Analysis | `CORAL_PROJECT/analysis/*-init-*.md` | If existing project | Scan Report section present |
  | Hub | `.claude/CLAUDE.md` | Must exist (created or pre-existing) | Quality principle line present |
  | Rules | `.claude/rules/agents.md` | Must exist | - |
  | Rules | `.claude/rules/design-philosophy.md` | Must exist | - |
  | Rules | `.claude/rules/validation.md` | Must exist | - |
  | Rules | `.claude/rules/conventions.md` | Must exist | `## Comments` section present |
  | Rules | `.claude/rules/{domain-specific}.md` | At least 1 per detected domain | `paths:` frontmatter, no `{placeholder}` text |
  | Agents | `.claude/agents/code-critic.md` | Must exist | Rubric anchors (10/7/4/1) |
  | Agents | `.claude/agents/doc-critic.md` | Must exist | Rubric anchors (10/7/4/1) |
  | Agents | `.claude/agents/test-critic.md` | Must exist | Rubric anchors (10/7/4/1) |
  | Template | `.claude/templates/AGENT.md` | Must NOT be created | Internal template — not deployed to user project |
  | Skills | `.claude/skills/tier-review/SKILL.md` | Must exist | `name: tier-review` in frontmatter |
  | Ignore | `.git/info/exclude` | For a Git repository | Anchored, literal-escaped project-relative `.claude/coral` entry |
  | Ignore | `.claude/.gitignore` | If it exists | Coral-owned standalone `coral` and `*.coral-*.tmp` lines absent; every other byte preserved |
  | Ignore | Git-root `.gitignore` | If it contained Coral's legacy project entry | Exact legacy entry absent; every other byte preserved |
  | Link | `.claude/coral` | Must exist as a symlink | Resolves to `CORAL_PROJECT` |
  | Agents | `.claude/agents/{domain-specific}.md` | Per plan | `<Agent_Prompt>` XML structure |
  | Docs | `docs/ARCHITECTURE.md` | If generated | Layer diagram present |
  | Docs | `docs/DEV_GUIDE.md` | If generated | Exact build/test commands |
  | Docs | `docs/{domain-specific}.md` | Per domain reference Recommended Docs | Architecture-level content, not catalogs |
  If any required file is missing or fails its content check, report it as an error.
</Output_Manifest>
<Constraints>
  | DO | DON'T |
  |----|-------|
  | Spawn coral:scanner subagent for existing projects | Perform inline scanning or guess the stack |
  | Execute all phases end-to-end without pausing | Stop between phases to ask for confirmation |
  | Write plan yourself, spawn reviewers at depth 1 | Delegate planning to a sub-agent (nesting limit) |
  | Spawn reviewers in parallel (single message) | Run reviewers sequentially |
  | Read merge-policy.md and writing-guide.md before generating | Decide merge policy ad-hoc |
  | Report everything (created + enhanced + updated) | Hide enhanced/updated files from the user |
  | Follow merge policy exactly | Overwrite existing user files |
  | Execute phases in order (1→2→3→4→5→6) | Skip to file generation without plan |
  | List the full `templates/` tree (`find … -type f`) before concluding a template is missing | Conclude "no template" from a depth-limited or filtered `find` |
  | Copy fixed artifacts (tier-review SKILL, *-critic agents) from their template, then graft project hooks | Author fixed artifacts from memory or another repo's output |
  | Read each template in full and obey directives in its body | Treat templates as `{placeholder}`-only |
  | Diff each generated fixed artifact against its template in Phase 4 | Pass verification on a frontmatter-key existence check |
  | Enumerate concerns→severity→agent before writing agents; one agent per concern; justify omissions in agents.md | Bundle multiple distinct concerns into one guardian |
</Constraints>
<Error_Handling>
  | Scenario | Action |
  |----------|--------|
  | Scanner subagent fails or returns insufficient output | Fall back to direct file reading (metadata, README, directory structure) and write a minimal analysis file. Note gaps in Phase 6 report |
  | Reviewer spawn fails | Proceed with other reviewer's feedback; if both fail, do single self-review |
  | Phase 3 generation fails partway | Report error with partial results |
  | Domain reference file not found | Proceed with available references, note the missing domain |
  | Template file not found | FIRST confirm genuine absence with a full `find {skill_base_dir}/templates -type f` (no `-maxdepth`, no `grep`) — a partial or filtered listing has falsely triggered this fallback. Only then report for that artifact and continue |
  | File already exists | Follow merge rule from plan: enhance (append missing sections) or update (patch stale content). Preserve non-cited content. Include in report as enhanced/updated |
  | Project-ignore maintainer returns `partial` | STOP Phase 5. Report every completed artifact disposition and the refusal; do not claim earlier changes were rolled back |
  | Project-ignore maintainer returns `refused` | STOP Phase 5. Report the refusal and repair the named unsafe, oversized, or unwritable path before retrying |
</Error_Handling>
