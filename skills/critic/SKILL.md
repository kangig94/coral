---
name: critic
description: Critical review of code or plans via Claude-native analysis
argument-hint: "[review target or question]"
---

# Critical Review

Execute a critical review using Claude's native analysis capabilities.

## Execution

1. **Load protocol**: Read `agents/critic.md` to load the full critic protocol
2. **Apply Investigation_Protocol**: Follow the numbered steps in the protocol's `<Investigation_Protocol>` section
3. **Use Claude-native tools**: Read, Grep, Glob, LSP tools to verify file references and simulate implementation
4. **Present findings**: Use the protocol's `<Output_Format>` with severity-rated findings (CRITICAL/HIGH/MEDIUM/LOW)
5. **Issue verdict**: OKAY (actionable) or REJECT (gaps found, with specific improvements)

## Context Enhancement

From the current conversation, identify and include in your review:
- The plan or code being reviewed
- Acceptance criteria if any
- Prior review feedback if this is a re-review

## Error Policy

If `agents/critic.md` cannot be read, report the error to the user. Do not fall back to inline analysis — the agent protocol is a required dependency.
