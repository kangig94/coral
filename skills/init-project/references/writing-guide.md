# Writing Guide - Agent and Doc Quality Patterns

Quality patterns for generating agents and documentation.

## Agent Writing Rules

### Required Sections (every agent)

Every generated agent MUST use `<Agent_Prompt>` XML structure with these sections:

1. **`<Role>`** - "You are [role]. Responsible for: X. NOT responsible for: Y." + When to Invoke table (Situation/Priority)
2. **`<Success_Criteria>`** - Measurable criteria. Use BLOCKING/STRONG/MINOR hierarchy where applicable
3. **`<Constraints>`** - DO/DON'T table. Include consultation rules as "Consult X BEFORE/AFTER Y" rows
4. **`<Investigation_Protocol>`** - Numbered review/execution steps with code examples
5. **`<Output_Format>`** - Structured output template with tables
6. **`<Failure_Modes_To_Avoid>`** - Common mistakes with "Instead:" corrections

Optional but recommended for review/safety agents:
- **`<Tool_Usage>`** - Detection bash commands + key files with concerns (required when agent has specific detection commands or file dependencies)

### Tier-Specific Requirements

| Tier | Additional Sections |
|------|-------------------|
| 0 (orchestration) | **`<Why_This_Matters>`** (design philosophy), invocation order in Investigation_Protocol |
| 1 (safety) | **`<Why_This_Matters>`** (design philosophy), **`<Failure_Modes_To_Avoid>`** with Bug/Symptom/Detection/Fix table |
| 2 (domain) | `<Failure_Modes_To_Avoid>` with diagnostic table recommended but optional |
| 3 (quality) | Standard sections sufficient |

### Quality Rules

1. **Concrete code examples** in `<Investigation_Protocol>` - never abstract descriptions.
   - BAD: "Ensure proper cleanup"
   - GOOD: Show the exact code pattern with `// correct` vs `// wrong` comments

2. **`<Failure_Modes_To_Avoid>` diagnostic table** for safety agents (tier 1):
   | Bug | Symptom | Detection | Fix |
   |-----|---------|-----------|-----|
   | GPU context leak | Segfault on second render | `cuCtxGetCurrent` returns NULL | Pair push/pop in RAII wrapper |

3. **Detection Commands in `<Tool_Usage>`** must be runnable - no pseudo-commands.

4. **Consultation rules in `<Constraints>`** use concrete task types, not abstract categories.
   - BAD: "When changing important code"
   - GOOD: "Consult mcp-guardian BEFORE modifying GPU memory allocation functions"

### Quality Review Agent Design

Tier 3 quality agents (code-critic, ux-critic, and domain-specific reviewers) must use rubric-anchored scoring:

1. **Multi-dimensional scoring** - decompose quality into 3-5 measurable dimensions, not a single number. Each dimension evaluates a distinct aspect of quality.
2. **4-tier rubric anchors** per dimension - define what 10, 7, 4, and 1 look like concretely. Anchors make the evaluation philosophy executable and repeatable.
3. **Floor rule** - any single dimension below 4 triggers NEEDS WORK regardless of composite score. One catastrophic weakness cannot be averaged away by strengths.
4. **Evidence requirement** - every score must cite file:line evidence. No "looks good" verdicts.
5. **Composite score** - average of all dimensions (rounded). The composite summarizes; individual dimensions diagnose.

The rubric anchors ARE the philosophy - they encode what the project values into repeatable evaluation criteria. A reviewer without anchored rubric produces inconsistent, personality-dependent results.

## Rules vs Docs Boundary

Rules contain **principles** (stable, rarely change). Docs contain **facts** (change with code). Rules may REFERENCE docs but must never DUPLICATE doc content.

| Content Type | Belongs In | Example |
|---|---|---|
| Modification policy per directory | Rules (design-philosophy) | "csrc/bindings/ must not include CUDA headers" |
| Dependency direction principle | Rules (design-philosophy) | "Code in layer Lx may only depend on L0..L(x-1)" |
| Current module dependency graph | Docs (architecture.md) | `server.ts → server-handlers.ts → ...` |
| Specific file list / line counts | Docs (core-modules.md) | "server.ts is 58 lines of wiring" |
| Naming conventions | Rules (conventions) | "snake_case for MCP tools, camelCase for TypeScript" |
| Current API surface | Docs (mcp-tools.md) | Tool parameter tables |

**Test**: If the content needs updating when you refactor code (without changing any principle), it belongs in docs - not rules.

When rules need to reference architecture, use: `See docs/architecture.md for the current module graph.`

## Doc Writing Rules

### ARCHITECTURE.md Requirements

1. **Layer diagram** - ASCII or table showing module dependencies
2. **Dependency rules** - "Code in Lx may only depend on L0..L(x-1)"
3. **Modification policy** per directory - who can change what, with what restrictions
4. **Key files** - List critical and non-obvious files only (5-15 entries, not exhaustive). Do not list every file in the repository.
5. **Must reference actual project paths** - no placeholders like `src/modules/`

For existing projects: derive from scanned directory structure and import graph.
For new projects: note "to be updated as architecture develops" where uncertain.

### DEV_GUIDE.md Requirements

1. **Build commands** - exact commands, not paraphrased
2. **Test commands** - how to run tests, what framework, coverage expectations
3. **Workflow phases** - before/during/after implementation steps
4. **Conventions** - naming, formatting, commit messages
5. **Must reference actual tooling** - package.json scripts, Makefile targets, etc.

For new projects: note "to be confirmed" for unverified sections.

### CLAUDE.md Requirements

The generated CLAUDE.md is the project hub - every session reads it first. Beyond build commands and workflow steps, it must establish the quality philosophy that governs all subsequent work:

1. **Quality principle** - one line before the Workflow section stating what good code means for this project (e.g., "Good code guides readers naturally - structure reveals intent without requiring explanation.")
2. **Build commands** - exact, runnable commands
3. **Workflow phases** - before/during/after with scope gate for non-source changes
4. **Agent consultation matrix** - reference to `.claude/rules/agents.md`

The quality principle line acts as gravitational center - it pulls all subsequent decisions in the same direction without requiring separate instructions for each case.

### Domain-Specific Doc Requirements

Domain references define recommended docs with two priority levels:
- **Strong**: Generate unless the project is trivially small. Condition is a default-include signal.
- **Conditional**: Generate only when the specified detection signal is present in the scan results.

Quality rules:

1. **Real content only** - never generate empty boilerplate. If the scan doesn't reveal enough to populate a doc, skip it and note in the report.
2. **Actual project references** - use real file paths, table names, endpoints from the scan. No placeholders.
3. **Standard formats** - `model-card.md` follows Google Model Cards format, `api-reference.md` follows OpenAPI-style structure, `data-dictionary.md` uses source/table/column hierarchy.
4. **Architecture Sections** - domain-specific sections listed in references are appended to `ARCHITECTURE.md`, not created as separate files.

### General Doc Quality

- Use **tables** for structured information (agent lists, layer rules, checklists)
- Use **code blocks** for commands and examples
- Reference **actual file paths** in the project, not generic placeholders
- Keep sections **clear** - structure information to reduce cognitive load, not just save space. Numbered steps over walls of text, tables over prose lists
- Include **examples** where patterns are non-obvious
- **Docs describe architecture decisions and navigation - not source contents.** Any content that becomes stale when a function signature or schema field changes belongs in source code, not docs.

### Enhance Mode Rules

When augmenting existing docs (merge rule = "enhance"):

1. **Read first** - always read the full existing file before editing. Never append blind.
2. **Tone matching** - match the existing document's heading levels, list style (bullets vs numbers), table format, and voice (formal vs conversational).
3. **Depth calibration** - if existing sections average 8 lines, new sections should be ~8 lines. A 50-line addition to a 30-line doc destroys the reader's mental model.
4. **Structural preservation** - append new sections at the end or in the natural location. Never reorder existing sections.
5. **Boundary check** - add only what the plan specifies. An "enhance" instruction for one section is not permission to edit the entire file.

## Best Practices

### Agent Design
- `<Agent_Prompt>` XML template with tier-based required/optional sections
- Agents have explicit state machine diagrams for complex domains
- Validation gate: BLOCKING items prevent completion
- Agent tiering by model routing (opus for safety, sonnet for domain/quality)
- Consultation rules in `<Constraints>`: concrete task-type → agent mappings

### Project Setup
- Two-layer system: generic capabilities + project-specific knowledge
- Language-specific rules organized by domain
- Workflow-driven structure: plan → execute → verify → finish
- Verification-before-completion pattern
- KB entries for debugging lessons - structured as Rule/Why/Pattern
