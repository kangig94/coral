# Writing Guide - Agent and Doc Quality Patterns

Quality patterns for generating agents and documentation.

## Agent Writing Rules

### Required Sections (every agent)

Every generated agent MUST include these sections:

1. **Purpose** - 2-3 sentences explaining core responsibility
2. **When to Invoke** - Table: Situation | Priority (MANDATORY/RECOMMENDED/OPTIONAL)
3. **Mandatory Consultations** - Table: Before/After | Agent | Reason
4. **Core Patterns** - Concrete code examples with explanations
5. **Validation Checklist** - Actionable items to verify
6. **Detection Commands** - Bash commands to find issues
7. **Key Files** - Table: File | Concern
8. **Output Format** - What the agent produces

### Tier-Specific Requirements

| Tier | Additional Sections |
|------|-------------------|
| 0 (orchestration) | Invocation order, verdict criteria |
| 1 (safety) | **Design Philosophy** (why this exists), **Anti-Patterns** table (Bug/Symptom/Detection/Fix) |
| 2 (domain) | Anti-Patterns recommended but optional |
| 3 (quality) | Standard sections sufficient |

### Quality Rules

1. **Concrete code examples** in Core Patterns - never abstract descriptions.
   - BAD: "Ensure proper cleanup"
   - GOOD: Show the exact code pattern with `// correct` vs `// wrong` comments

2. **Anti-Patterns table** for safety agents:
   | Bug | Symptom | Detection | Fix |
   |-----|---------|-----------|-----|
   | GPU context leak | Segfault on second render | `cuCtxGetCurrent` returns NULL | Pair push/pop in RAII wrapper |

3. **Detection Commands** must be runnable - no pseudo-commands.

4. **Consultation matrix** uses concrete task types, not abstract categories.
   - BAD: "When changing important code"
   - GOOD: "When modifying GPU memory allocation functions"

## Doc Writing Rules

### ARCHITECTURE.md Requirements

1. **Layer diagram** - ASCII or table showing module dependencies
2. **Dependency rules** - "Code in Lx may only depend on L0..L(x-1)"
3. **Modification policy** per directory - who can change what, with what restrictions
4. **Key files table** - File | Role | Sensitivity
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

### General Doc Quality

- Use **tables** for structured information (agent lists, layer rules, checklists)
- Use **code blocks** for commands and examples
- Reference **actual file paths** in the project, not generic placeholders
- Keep sections **concise** - every sentence should add value
- Include **examples** where patterns are non-obvious

## Best Practices

### Agent Design
- TEMPLATE.md with REQUIRED/OPTIONAL section markers by tier
- Agents have explicit state machine diagrams for complex domains
- Validation gate: BLOCKING items prevent completion
- Agent tiering by model routing (opus for safety, sonnet for domain/quality)
- Consultation matrix: task-type → agent mapping with Before/After structure

### Project Setup
- Two-layer system: generic capabilities + project-specific knowledge
- Language-specific rules organized by domain
- Workflow-driven structure: plan → execute → verify → finish
- Verification-before-completion pattern
- KB entries for debugging lessons - structured as Rule/Why/Pattern
