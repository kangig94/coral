# Coral CLI

CLI: `coral-cli`

When the current session is sandboxed, invoke this CLI with sandbox bypass/escalation; it will not work from inside the sandbox.

Invoking a skill that uses Coral expresses the user's intent to run Coral. For Coral CLI calls made by that skill, automatically use sandbox bypass/escalation when the session is sandboxed; do not first attempt the CLI inside the sandbox or ask for separate confirmation solely for the bypass.

Provider and workflow commands return after the launch decision and print `command=coral-cli jobs wait <job-id>` on acceptance. Wait for every job you launch until it reaches a terminal state. Only when the user explicitly asks to leave a job running unattended, run `coral-cli jobs release <job-id>` for that job.

Use harness background execution for long waits. For interim progress, run GNU coreutils' `timeout --preserve-status 100 coral-cli jobs wait <job-id>` and resume with the printed `--cursor`. On macOS use `gtimeout` from `brew install coreutils`.

By default, multi-job waits return at the first terminal poll. Collect all results with `coral-cli jobs wait <job-id...> --all`. Unbound operators can use `jobs detail` and `jobs wait` from any cwd. A bound caller’s cwd must be inside its binding and contain the job’s work directory. Send, abort, and release remain cwd-scoped.

Use `coral-cli jobs send <job-id> -i <text|file|->` to steer a running provider turn or continue an ended job launched through a provider command. A continuation starts the next execution in the same conversation and returns with a wait command. A steer returns after delivery. `delivered` acknowledges handoff to the provider input. Check job progress for evidence that the agent read it. Follow the guidance for a refusal. After `unknown`, check progress with `coral-cli jobs wait <job-id>` and pause any resend until you can establish what happened.
