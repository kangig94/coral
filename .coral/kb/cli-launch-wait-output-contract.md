# CLI Launch-Then-Wait Output Contract Must Preserve Launch Metadata
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
When a CLI launch command (`exec`/`fork`/dispatch/workflow-style) changes from returning a one-shot `LaunchDecision` to auto-entering a live wait stream, define one public output contract up front. Either keep the default output as a pure wait stream and explicitly accept that early launch metadata is unavailable until later events, or emit a first-class launch event before wait events. Do not claim "same as wait" while also expecting the default path to preserve immediate `job`/`session` data, and treat inline-embed defaults as a separate product decision rather than an implied consequence of auto-wait.
## Why
Auto-wait looks like a small UX change, but it actually collapses two previously separate phases into one command surface. Without an explicit contract, JSON mode becomes self-contradictory: callers either lose launch metadata on timeout/interruption or receive an undocumented mixed stream. Text mode can hide this ambiguity, but machine-readable consumers cannot. Bundling embed-default changes into the same rollout also obscures whether a regression came from the launch/wait contract or from path-vs-inline result policy.
## Pattern
Right:
```typescript
type LaunchWaitEvent =
  | { type: 'launch'; decision: LaunchDecision }
  | { type: 'queued'; ... }
  | { type: 'progress'; ... }
  | { type: 'terminal'; ... }
  | { type: 'timeout'; ... };

yield { type: 'launch', decision };
for await (const event of wait(jobIds, options)) {
  yield event;
}
```

```typescript
// If parity with wait is the goal, say so explicitly and accept the tradeoff.
if (mode === 'wait_parity') {
  // Output starts at queued/progress/terminal; no separate launch record.
}
```

Wrong:
```typescript
const decision = await launch();
// Stream wait events only...
// ...but still document JSON output as both "same as wait" and "preserves launch info".
```
