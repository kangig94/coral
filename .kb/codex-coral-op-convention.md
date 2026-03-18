# Codex `coral:*` Delegation Convention

## Rule
Use `codex({ op: "coral:<agent-name>", ... })` for Codex-side agent delegation. The `op` suffix maps directly to `agents/<agent-name>.md`; the server reads that file, prepends its content to the user prompt, and dispatches through the standard async Codex pipeline.

## Why
This removes the extra LLM hop from the former proxy-agent pattern. Delegation becomes mechanical (resolve file + prepend + execute), keeps agent definitions in one place (`agents/`), and avoids stale role mappings or hook-coupled routing logic.

## Pattern
```typescript
// New session
codex({
  op: "coral:architect",
  prompt: "Review this plan for missing failure modes.",
  work_dir,
  effort: "xhigh",
});

// Session continuation
codex({
  op: "coral:architect",
  session,
  prompt: "Re-check after these edits.",
});
```

- Allowed format: `coral:[a-z0-9][a-z0-9-]*`
- Rejected before filesystem read: `coral:`, `coral:../x`, `coral:scanner/extra`
- Unknown file error: `Agent file not found: agents/<agent>.md`
- Prompt order: `CLAUDE.md` (one-shot only) → `agents/<agent>.md` → user prompt

## History
Older workflows used `coral:codex-proxy` plus a `SubagentStart` hook to force delegation. That design was replaced by direct `coral:*` ops and executor-side `ensureMultiAgent()`, eliminating the proxy file and hook dependency.
