---
name: init-project
description: Initialize project for AI-assisted development with rules, agents, CLAUDE.md, docs, and settings
argument-hint: "[existing|new]"
---

# Project Initialization

Set up a project for AI-assisted development. Scans the project, plans appropriate artifacts with architect/critic review, then generates everything.

## Execution

1. **Phase 1 — Scan** (you execute directly):
   - Read `agents/init-project.md` for domain detection rules and reference loading instructions
   - Detect scenario (existing vs new project)
   - Extract context from user arguments
   - Scan references if provided
   - Scan project structure (existing projects)
   - Identify domains and load domain references from `references/*.md`
   - Load templates from `templates/`

2. **Phase 2 — Plan** (delegate via Task tool):
   Use the Task tool to spawn the planner sub-agent. Do NOT write the plan yourself.
   ~~~~
   Task(subagent_type="coral:planner", prompt="""
     Task: Plan artifacts for {project} initialization.
     Reviewers: coral:architect, coral:critic
     Plan name: init-{project-name}

     Context:
       Scenario: {existing|new}
       Detected domains: {list}
       Domain reference content: {extracted}
       Template descriptions: {from templates/}
       Merge policy: {from references/merge-policy.md}

     Plan structure: Requirements, Acceptance Criteria, Tasks (ordered with [ ] checkboxes, each verifiable), Risks.
     For each artifact: file path, content description, merge rule.
   """)
   ~~~~
   **GATE**: Planner returns plan file path. If planner fails, fall back per protocol.
   Do NOT proceed without a plan file path.

3. **Phase 3 — Execute** (delegate via Task tool):
   Use the Task tool to spawn ralph. Do NOT create project files yourself.
   ~~~~
   Task(subagent_type="coral:ralph", prompt="""
     Task: Generate all artifacts per the plan.
     Plan file: {plan_file_path from Phase 2}
     Working directory: {project root}
     Templates: {skill_base_dir}/templates/
     References: {skill_base_dir}/references/
   Note: {skill_base_dir} is the absolute plugin path provided by the skill loading system.
   Do NOT use relative paths — ralph runs in the target project directory, not the plugin directory.

     Follow the deterministic generation rules in agents/init-project.md Phase 3.
     Verify each file creation.
   """)
   ~~~~
   Ralph returns: execution report (files created, skipped, errors).

4. **Phase 4 — Report & Verify** (you execute directly):
   - Summarize created/skipped files per protocol's output format
   - Run Output Manifest Verification (see below)

## Output Manifest Verification (Phase 4)

After ralph completes, verify these files exist. Missing files indicate protocol failure.

### Required Artifacts
| Category | File | Condition |
|----------|------|-----------|
| Hub | `.claude/CLAUDE.md` | Must exist (created or pre-existing) |
| Rules | `.claude/rules/agents.md` | Must exist |
| Rules | `.claude/rules/design-philosophy.md` | Must exist |
| Rules | `.claude/rules/validation.md` | Must exist |
| Rules | `.claude/rules/conventions.md` | Must exist |
| Rules | `.claude/rules/workflow.md` | Must exist |
| Rules | `.claude/rules/{domain-specific}.md` | At least 1 per detected domain |
| Agents | `.claude/agents/review-orchestrator.md` | Must exist |
| Agents | `.claude/agents/code-critic.md` | Must exist |
| Agents | `.claude/agents/TEMPLATE.md` | Must exist |
| Agents | `.claude/agents/{domain-specific}.md` | Per plan |
| Settings | `.claude/settings.local.json` | Must exist |
| KB | `.claude/coral/kb/` | Directory must exist |
| Git | `.gitignore` contains Coral block | Must contain `# Coral` |

If any required file is missing, report it as an error in Phase 4 output.

## Critical Rules
- Phase 2 and 3 MUST use the Task tool. If you find yourself using Write/Edit for
  project artifacts (agents, rules, CLAUDE.md, settings), you are violating the protocol.
- The only files you may write directly are scan notes in `.claude/coral/plans/`.
