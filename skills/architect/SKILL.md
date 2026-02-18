---
name: architect
description: Architecture review via Claude-native analysis
argument-hint: "[review target or question]"
---

# Architecture Review

Execute an architecture review using Claude's native analysis capabilities.

## Execution

1. **Load protocol**: Read `agents/architect.md` to load the full architect protocol
2. **Apply Investigation_Protocol**: Follow the numbered steps in the protocol's `<Investigation_Protocol>` section
3. **Use Claude-native tools**: Read, Grep, Glob, LSP tools to examine the codebase directly
4. **Present findings**: Use the protocol's `<Output_Format>` with severity-rated findings
5. **Include verdict**: End with APPROVED, APPROVED WITH CONDITIONS, or REJECT with specific reasons

## Context Enhancement

From the current conversation, identify and include in your analysis:
- File paths being discussed
- Key code patterns or structures relevant to the review
- Constraints or requirements the user has mentioned

## Error Policy

If `agents/architect.md` cannot be read, report the error to the user. Do not fall back to inline analysis — the agent protocol is a required dependency.
