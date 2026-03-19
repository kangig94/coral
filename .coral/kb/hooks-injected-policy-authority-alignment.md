# Hook-Injected Policy Must Match the Authoritative Workflow
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
Any hook that injects `additionalContext` or Stop-hook blocking guidance must restate the same workflow as the repository's authoritative instructions. If the canonical KB flow is memo → review → promotion, hooks must never tell the model to write directly to `.claude/coral/kb/`, because hook text is live behavioral authority during execution.
## Why
Coral relies on hooks to steer model behavior at the exact moment decisions are made. A conflicting hook does more damage than stale docs: the model sees the injected instruction in-session and may follow it immediately, bypassing the intended memo review gate. That turns the enforcement mechanism into a policy violation source and makes KB hygiene nondeterministic across sessions.
## Pattern
```js
// WRONG: hook text contradicts the repo workflow
additionalContext: 'Write it directly to .claude/coral/kb/.'

// RIGHT: hook text reinforces the authoritative path
additionalContext:
  'Review memos. Promote only durable lessons to .claude/coral/kb/. Delete all processed memos.'
```

```md
## Canonical workflow
1. Write a memo to `.claude/coral/memo/...`
2. Review memos at task end
3. Promote only genuinely reusable knowledge
4. Delete processed memos
```
