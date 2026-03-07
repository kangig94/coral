# Agent Template

All agents use `<Agent_Prompt>` XML structure.

```yaml
---
name: <agent-name>
description: "<description>. Use when [trigger]. NOT for [exclusion]."
model: <opus|sonnet>
---
```

```xml
<Agent_Prompt>
  <Role>
    You are [role]. Your mission is [mission].
    You are responsible for: [responsibilities].
    You are NOT responsible for: [exclusions with agent names].

    | Situation | Priority |
    |-----------|----------|
    | [trigger condition] | MANDATORY / RECOMMENDED / OPTIONAL |
  </Role>
  <Success_Criteria>
    - [Measurable criterion 1]
    - [Measurable criterion 2]
  </Success_Criteria>
  <Constraints>
    [ONE-LINE IRON LAW IN CAPS]

    | DO | DON'T |
    |----|-------|
    | [correct behavior] | [incorrect behavior] |
  </Constraints>
  <Output_Format>
    ## Report Title
    ### Section
    | Column | Column |
    |--------|--------|
  </Output_Format>
</Agent_Prompt>
```

### Required Sections (WHO / WHAT / GUARD / FORMAT)

| Section | Description |
|---------|-------------|
| `Role` | WHO — core responsibility + explicit NOT-responsible boundaries + When to Invoke table |
| `Success_Criteria` | WHAT — measurable completion criteria |
| `Constraints` | GUARD — iron law + DO/DON'T table. Compress failure modes here as one-liners. |
| `Output_Format` | FORMAT — structured output template with tables |

### Optional Sections

| Section | When to Include |
|---------|-----------------|
| `Investigation_Protocol` or `Protocol` | Agent has a multi-step procedure that LLMs wouldn't follow naturally (e.g., scanner's dual approach, discuss-lead's state machine) |
| `Tool_Usage` | Agent uses MCP tools — document op names and parameters only. Omit for standard tools (Read, Write, Grep, etc.) |
| `Input` | Agent receives structured input that must be parsed (e.g., persona-generator) |
| `Error_Handling` | Agent interacts with APIs that return error states (e.g., discussant) |

### Frontmatter Options

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | kebab-case agent name |
| `description` | yes | One-line with "Use when... NOT for..." |
| `model` | yes | `opus` (deep reasoning) or `sonnet` (protocol execution) |
| `methods` | no | HOW methods list, e.g., `[HOW-REVIEW, HOW-PROVENANCE]` |
| `deep` | no | `bool` — enables `--deep` flag for HOW method injection |
| `disallowedTools` | no | `Write, Edit` for read-only agents |
| `tools` | no | Restrict to specific MCP tools for specialized agent execution |
