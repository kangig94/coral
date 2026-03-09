# Sandbox HOME must be writable for CLI tests

## Rule
Run `HOME=/tmp npm test` in sandboxed environments. Both SessionManager (`~/.claude/coral/execution/sessions/`) and Claude CLI (`~/.claude/`) require writable HOME; sandbox restrictions cause false test failures.

## Why
Tests pass locally but fail in sandboxed agents/CI because file writes to `$HOME/.claude/` are denied. These appear as real regressions but are environment artifacts. Additionally, Claude CLI `--resume` requires `~/.claude` to persist session state — if HOME is not writable, `--resume` fails with "No conversation found" even when the initial call returned a valid `session_id`.

## Pattern
```bash
# WRONG — sandbox denies writes to /home/user/.claude/
npm test

# RIGHT — writable HOME avoids false failures
HOME=/tmp npm test
```

For Claude CLI resume tests, also copy credentials to the writable HOME:
```bash
mkdir -p /tmp/claude-home/.claude
cp ~/.claude/.credentials.json /tmp/claude-home/.claude/
HOME=/tmp/claude-home claude -p "test" --output-format json
HOME=/tmp/claude-home claude -p "continue" --resume $SESSION_ID --output-format json
```
