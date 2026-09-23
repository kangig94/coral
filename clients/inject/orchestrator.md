# Delegation

Project agents in `.claude/agents/` run through a provider — e.g. `CLI codex <agent> -i "<prompt>"` (swap `codex`→`claude` for the Claude provider). Resolution checks the project's `.claude/agents/<name>.md` first, then Coral's bundled agents.
