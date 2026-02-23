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
  <Why_This_Matters>
    [What fails without this agent. Why manual/naive approach breaks.]
  </Why_This_Matters>
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
  <Investigation_Protocol>
    1) [Step with sub-steps a, b, c]
    2) [Step]
  </Investigation_Protocol>
  <Tool_Usage>
    [Which tools and why. MCP tool names if delegating.]
  </Tool_Usage>
  <Output_Format>
    ## Report Title
    ### Section
    | Column | Column |
    |--------|--------|
  </Output_Format>
  <Failure_Modes_To_Avoid>
    - [Mode]: [What goes wrong]. Instead: [correction].
  </Failure_Modes_To_Avoid>
</Agent_Prompt>
```

### Required Sections

| Section | Description |
|---------|-------------|
| `Role` | Core responsibility + explicit NOT-responsible boundaries + When to Invoke table |
| `Success_Criteria` | Measurable completion criteria |
| `Constraints` | Iron law + DO/DON'T table |
| `Investigation_Protocol` or `Protocol` | Numbered execution steps (analysis agents use Investigation_Protocol, orchestrators use Protocol) |
| `Output_Format` | Structured output template with tables |
| `Failure_Modes_To_Avoid` | Common mistakes with "Instead:" corrections |

### Optional Sections

| Section | When to Include | Used By |
|---------|-----------------|---------|
| `Why_This_Matters` | Tier 0-1 required. Why this agent exists, what fails without it | review-orchestrator, mcp-guardian, init-project, ralph, debugger |
| `Tool_Usage` | Agent uses specific tools or delegates to MCP | analyst, architect, critic, ralph, red-attacker |
| `Examples` | Good/Bad execution pairs clarify protocol | analyst, architect, critic, ralph, init-project |
| `Final_Checklist` | Pre-completion self-check prevents false done | analyst, architect, critic, ralph, planner |
| `Execution_Policy` | Effort level, stop conditions, parallelism | analyst, architect, critic, ralph |
| `Error_Handling` | Orchestrators with multiple failure scenarios | init-project, planner, discussant |
| `Model_Selection` | Agent delegates to different models conditionally | red-attacker |
| `Iteration_Cap` | Long-running loops need explicit bounds | ralph |
| `Circuit_Breaker` | Prevents infinite retry on same failure | ralph |
| `Rationalization_Prevention` | Excuse → reality table for anti-hallucination | ralph, critic |

### Frontmatter Options

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | kebab-case agent name |
| `description` | yes | One-line with "Use when... NOT for..." |
| `model` | yes | `opus` (tier 0-1, deep reasoning) or `sonnet` (tier 2-3, protocol execution) |
| `disallowedTools` | review agents | `Write, Edit` for read-only agents (all agents in `.claude/agents/`) |
| `tools` | no | Restrict to specific MCP tools (used by codex-proxy) |

### Model Assignment Rule

- Tier 0 (supervisor): opus
- Tier 1 (safety-critical): opus
- Tier 2 (domain experts): sonnet
- Tier 3 (quality): sonnet
- Never use haiku for any review or execution agent
