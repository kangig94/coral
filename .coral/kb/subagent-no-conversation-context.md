# Subagents Do Not Receive Parent Conversation History

## Rule
Claude Code subagents (spawned via the Agent tool) do NOT inherit the parent conversation history. They receive only: (1) project-level instructions (CLAUDE.md, rules), (2) environment metadata (git status, working directory), and (3) the explicit prompt passed at spawn time. Any context needed for the subagent's task must be serialized into the spawn prompt.

## Why
Without this knowledge, you may assume subagents have conversation context and write sparse prompts like "review the plan we discussed." The subagent will have zero knowledge of what was discussed. This also has architectural implications: the "context transfer cost" argument against extracting agent pipelines into separate processes (e.g., MCP-orchestrated CLI sessions) is invalid — subagents already require the same explicit context serialization that a separate process would need.

## Pattern

Wrong — assuming subagent sees conversation:
```
Agent(prompt: "Review the architect and critic feedback and resolve conflicts")
```

Right — explicitly passing all required context:
```
Agent(prompt: "Review these two files and resolve conflicts:\n- Architect review: /tmp/plan/architect-review.md\n- Critic review: /tmp/plan/critic-review.md\n- Original plan: /tmp/plan/plan.md\nResolve contradictions using TRIZ principles.")
```

Architectural implication: since subagents and separate CLI sessions have identical context transfer costs, MCP-orchestrated pipelines (spawning `claude --agent` per step) offer strictly better properties — deterministic protocol execution, fresh context per agent, no host context window pressure — with no additional context serialization overhead.
