# Codex Proxy Unification — Why One File Instead of Four

## Rule

Codex delegation agents (analyst, architect, critic, ralph) should live in a single `agents/codex-proxy.md` with role-based routing (`Role: analyst|architect|critic|ralph` in the caller's prompt), not as four separate agent files.

## Why

**Prompt caching**: Anthropic's prompt caching works on system prompt prefix matching. When two subagents are spawned in parallel (e.g., `coral:codex-proxy Role:architect` + `coral:codex-proxy Role:critic` for review), they share identical system prompts up to the role-selection point. The Claude Code base (~25k tokens) is always cached; agent `.md` content is injected on top. With four separate files, each spawned agent had a unique system prompt — no cross-agent cache reuse. With one unified file, both agents share the same system prompt prefix, maximizing cache hit probability.

**DRY maintenance**: The four original agents shared 60-70% duplicate content (Proxy_Protocol, Working_Directory requirements, Session_Continuity, Failure_Modes patterns). Any behavioral fix (e.g., updating the Output_Handling table) had to be applied to all four files separately, with drift risk over time.

## Pattern

```
# CORRECT: Single proxy with role routing (cache-friendly)
agents/codex-proxy.md          # all 4 roles in one file

Callers include:
  Role: architect               # in their Task prompt
  Role: critic                  # in their Task prompt

# WRONG: Separate files per role (no cross-agent cache sharing)
agents/codex-architect.md
agents/codex-critic.md
agents/codex-analyst.md
agents/codex-ralph.md
```

**Role-routing guarantee**: Callers always supply `Role: <name>` explicitly. Missing role → explicit error (no inference). This eliminates the fragile "infer from context" pattern that could silently default to the wrong behavior.

**Hook compatibility**: The `(^|:)codex-` regex in `hooks/hooks.json` matches `codex-proxy` without any change. All delegation guarantees (hook injection, tool restriction, system prompt protocol) apply to `codex-proxy` identically to the four predecessor agents.
