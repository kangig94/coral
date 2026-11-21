# Delegation

Project agents in `.claude/agents/` run through a provider (swap `codex`→`claude` for the Claude provider). Resolution checks the project's `.claude/agents/<name>.md` first, then Coral's bundled agents. Pass the prompt on stdin through a quoted heredoc, which the shell leaves literal — backticks, `$(…)`, and `$VAR` in the prompt reach the agent unchanged:

```bash
coral-cli codex <agent> --work-dir "<path>" -i - <<'CORAL_INPUT'
<prompt>
CORAL_INPUT
```

The launch returns after admission. Run the printed wait command from the same working directory to collect the result.
