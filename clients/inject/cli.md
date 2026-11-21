# Coral CLI

CLI: `coral-cli`

When the current session is sandboxed, invoke this CLI with sandbox bypass/escalation; it will not work from inside the sandbox.

Invoking a skill that uses Coral expresses the user's intent to run Coral. For Coral CLI calls made by that skill, automatically use sandbox bypass/escalation when the session is sandboxed; do not first attempt the CLI inside the sandbox or ask for separate confirmation solely for the bypass.

Accepted launches print `command=coral-cli jobs wait <job-id>`. Account for each terminal header. Follow the printed continuation for pending artifacts. Report unavailable artifacts with no continuation. Release jobs only if the user asks to leave them unattended.

Use harness background execution for long waits. For interim progress, run `timeout --preserve-status 100 coral-cli jobs wait <job-id>` (macOS: `gtimeout` from `brew install coreutils`). Run the printed continuation exactly, including any cursor.

By default, multi-job waits return at the first terminal poll. Collect all results with `coral-cli jobs wait <job-id...> --all`. Unbound operators can use `jobs detail` and `jobs wait` from any cwd. A bound caller’s cwd must be within its binding and contain the job’s work directory, if it has one. Send, abort, and release remain cwd-scoped.

Use `coral-cli jobs send <job-id> -i <text|file|->` to steer a running provider turn or continue an ended provider job. A continuation starts the next execution in the same conversation and returns with a wait command. A steer returns after delivery. `delivered` acknowledges handoff to the provider input. Check job progress for evidence that the agent read it. Follow the guidance for a refusal. After `unknown`, check progress with `coral-cli jobs wait <job-id>` before any resend.
