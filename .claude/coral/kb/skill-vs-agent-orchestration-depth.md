# Orchestrators That Spawn Agents Must Be Skills, Not Agents

Promoted: 2026-03-12 | Updated: 2026-03-12
## Rule
Subagents (spawned via Agent tool) have a nesting depth limit of 1 — they cannot spawn further subagents and cannot pass sub-subagent results back to the caller. Any component that needs to invoke multiple tier-based agents and consolidate their findings must run as a **skill** (in the main session context), not as an agent definition. The skill runs in the host session and can freely spawn agents via the Agent tool with results returned to the orchestrating skill.

## Why
An agent definition that claims to "invoke tier-based reviewers" will silently fail at runtime: the spawned subagent cannot itself use the Agent tool to spawn further agents. This leads to incorrect behavior where the orchestrator appears to complete but no review agents were actually invoked. The `review-orchestrator` agent was deleted and replaced with a `/review` skill for exactly this reason.

## Pattern
Wrong — orchestrator as agent definition (cannot spawn further agents):
```
# agents/review-orchestrator.md
# Claims to spawn mcp-guardian, hook-safety, code-critic
# → fails silently at depth limit
Agent(subagent_type: "review-orchestrator", prompt: "review these changes")
```

Right — orchestrator as skill (runs in main session, can spawn agents freely):
```
# skills/review/SKILL.md
# Skill runs in main session → can use Agent tool to spawn tier-based agents
# Reads .claude/rules/agents.md consultation matrix
# Spawns agents by tier, collects results, consolidates
Skill({ skill: "coral:review" })
```

Implication: when designing review or multi-agent pipeline workflows, always implement the coordinating layer as a skill or inline main-session code, reserving agent definitions for leaf-level reviewers/executors that don't need to spawn further agents.
