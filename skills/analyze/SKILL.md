---
name: analyze
description: Deep analysis and investigation via Claude-native analysis
argument-hint: "[investigation target or question]"
---

# Deep Analysis & Investigation

Execute a thorough analysis using Claude's native analysis capabilities.

## Execution

1. **Load protocol**: Read `agents/analyst.md` to load the full analyst protocol
2. **Apply Investigation_Protocol**: Follow the numbered steps in the protocol's `<Investigation_Protocol>` section
3. **Use Claude-native tools**: Read, Grep, Glob, LSP tools to trace code paths and gather evidence
4. **Present findings**: Use the protocol's `<Output_Format>` to present findings by severity
5. **Prioritize**: Critical gaps first, nice-to-haves last

## Context Enhancement

From the current conversation, identify and include in your analysis:
- Error messages, stack traces, or symptoms being investigated
- Files and code paths relevant to the issue
- What has already been tried or ruled out

## Error Policy

If `agents/analyst.md` cannot be read, report the error to the user. Do not fall back to inline analysis — the agent protocol is a required dependency.
