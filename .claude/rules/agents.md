# Agent System

## Agent Quick Reference

| Agent | File | Model | Tier | Purpose |
|-------|------|-------|------|---------|
| review-orchestrator | `.claude/agents/review-orchestrator.md` | opus | 0 | Final validation supervisor |
| mcp-guardian | `.claude/agents/mcp-guardian.md` | opus | 1 | MCP protocol compliance, tool schema validation |
| hook-safety | `.claude/agents/hook-safety.md` | sonnet | 2 | Hook timeout safety, Node.js ESM conventions |
| skill-quality | `.claude/agents/skill-quality.md` | sonnet | 2 | SKILL.md quality, frontmatter correctness |
| code-critic | `.claude/agents/code-critic.md` | sonnet | 3 | Code quality, elegance, complexity |
| ux-critic | `.claude/agents/ux-critic.md` | sonnet | 3 | Plugin UX, skill discoverability, MCP tool ergonomics |

## Consultation Matrix

| Task Category | MANDATORY Consultations | RECOMMENDED Consultations | Reason |
|---------------|------------------------|---------------------------|--------|
| MCP tool handler changes | mcp-guardian | code-critic | Protocol compliance is blocking |
| Zod schema changes | mcp-guardian, code-critic | ux-critic | Schema correctness + API ergonomics |
| Hook script changes | hook-safety | code-critic | Timeout safety + Node.js ESM conventions |
| SKILL.md changes | skill-quality | ux-critic | Frontmatter correctness + discoverability |
| Agent definition changes | review-orchestrator | code-critic | Agent system coherence |
| Session manager changes | mcp-guardian, code-critic | -- | Atomic writes + error handling |
| Output parser changes | mcp-guardian | code-critic | JSONL contract correctness |
| State machine changes | mcp-guardian, code-critic | -- | Pure function correctness + discuss protocol |
| New MCP tool addition | mcp-guardian, ux-critic | code-critic | Protocol + ergonomics + quality |
| Any implementation complete | review-orchestrator | -- | Final validation gate |

## Invocation Protocol

```
@<agent-name> <brief description of what to review>
```

Examples:
```
@mcp-guardian Review schema validation in discuss server-handlers.ts
@hook-safety Check discuss-idle-guard.mjs for timeout safety
@skill-quality Validate frontmatter in skills/discuss/SKILL.md
@code-critic Review elegance of state-machine.ts resolveWinner function
@ux-critic Check argument ergonomics for discuss_lead tool (_3_step op)
```

Provide file paths and specific concerns. Consult agents early (before implementation) for guidance and late (after implementation) for validation.
