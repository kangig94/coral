# Claude CLI Adapter Design — Empirical Findings

## Rule
When building a Claude CLI MCP bridge, use `--system-prompt` for agent injection (not prompt prepend), `--resume` with `-p` mode for session continuity, and `--output-format json` for single-object parsing. Codex CLI lacks `--system-prompt`, so agent injection must remain prompt-prepend for Codex.

## Why
These capability differences between Claude CLI and Codex CLI drive divergent adapter implementations — sharing the injection strategy across both providers would either bloat prompt tokens for Claude or lose system-prompt isolation for Codex.

## Pattern

| Capability | Claude CLI | Codex CLI |
|------------|-----------|-----------|
| Agent/system injection | `--system-prompt <content>` | Prepend to prompt |
| Session resume | `--resume <session_id>` with `-p` | `exec resume <thread_id>` |
| Output format | `--output-format json` → single JSON object | `--json` → JSONL stream |
| Cost with system prompt | ~$0.03 (2K tokens) vs $0.19 (29K) default | N/A |
| `CLAUDECODE` env var | Session-internal only — not in MCP process | N/A |
| Session ID control | `--session-id <uuid>` allows caller-specified IDs | Thread ID auto-assigned |

```typescript
// Claude adapter: strip frontmatter, pass as system prompt
const systemPrompt = stripAgentMetadata(resolved.content);
await executeClaudeOneShot(prompt, { systemPrompt, model, workingDirectory });

// Codex adapter: prepend full content to prompt
const injectedPrompt = `${resolved.content}\n\n---\n\n${codexCoralInput.prompt}`;
await handleCodexToolCall('codex', { op: 'exec', prompt: injectedPrompt, ... });
```

## Context
Validated empirically during ax-agent-runner preplan phase. The 7x cost reduction from `--system-prompt` is significant enough to make it mandatory for the Claude adapter, not optional.
