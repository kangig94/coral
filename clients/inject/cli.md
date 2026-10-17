# Coral CLI

CLI: `coral-cli`

When the current session is sandboxed, invoke this CLI with sandbox bypass/escalation; it will not work from inside the sandbox.

Invoking a skill that uses Coral expresses the user's intent to run Coral. For Coral CLI calls made by that skill, automatically use sandbox bypass/escalation when the session is sandboxed; do not first attempt the CLI inside the sandbox or ask for separate confirmation solely for the bypass.

Wait for every job you launch until it reaches a terminal state. Only when the user explicitly asks to leave a job running unattended, run `coral-cli jobs release <job-id>` for that job.

To add an instruction to a job whose turn is still running, run `coral-cli jobs send <job-id> -i <text|file|->`. It reaches only the running turn: a refusal prints what to do instead, and an ended turn needs a new job. `delivered` means handoff to the running turn, not that the agent read or will follow it; `coral-cli jobs wait <job-id>` progress shows whether it was read. After `unknown`, do not send again; check the job's progress with `coral-cli jobs wait <job-id>`.
