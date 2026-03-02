# Sandbox HOME must be writable for Codex tests

## Rule
Run `HOME=/tmp npm test` in sandboxed environments. SessionManager writes to `~/.claude/coral/sessions/`, and sandbox restrictions on the real HOME cause false test failures.

## Why
Tests pass locally but fail in sandboxed agents/CI because file writes to `$HOME/.claude/` are denied. These appear as real regressions but are environment artifacts.

## Pattern
```bash
# WRONG — sandbox denies writes to /home/user/.claude/
npm test

# RIGHT — writable HOME avoids false failures
HOME=/tmp npm test
```
