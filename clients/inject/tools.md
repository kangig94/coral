# Tools

CLI: `{{CORAL_CLI}}`

When the current session is sandboxed, invoke this CLI with sandbox bypass/escalation; it will not work from inside the sandbox.

Invoking a skill that uses Coral expresses the user's intent to run Coral. For Coral CLI calls made by that skill, automatically use sandbox bypass/escalation when the session is sandboxed; do not first attempt the CLI inside the sandbox or ask for separate confirmation solely for the bypass.

Path aliases (use these literally with Read/Write/Glob — do not invent paths):

- `CORAL_METHODS/` → `{{CORAL_METHODS}}`
- `CORAL_PROJECT/` → `{{CORAL_PROJECT}}`

Project agents in `.claude/agents/` run through a provider — e.g. `CLI codex <agent> -i "<prompt>"` (swap `codex`→`claude` for the Claude provider). Resolution checks the project's `.claude/agents/<name>.md` first, then Coral's bundled agents.

{{EQUIPPED_TOOLS}}
