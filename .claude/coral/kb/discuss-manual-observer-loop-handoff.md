# Manual Observer Discuss Loop Handoff
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
Treat provider-less `observer` agents in backend-managed discuss sessions as manual participants. Do not pre-seed them with a default provider, do not auto-collect their bids or speeches, stop the manager loop when one wins the floor, and resume the loop only after `discuss_participate` records the manual speech.
## Why
Without this split, `--user` sessions silently route observer turns through the default provider and the background loop races ahead before the human tool path can act. The session looks wired because the state machine accepts observer bids, but the wrong executor owns the turn, so `discuss_participate` becomes a late duplicate instead of the authoritative handoff.
## Pattern
Wrong:
```ts
for (const agent of agents) {
  session.agentRuns.set(agent.name, {
    provider: agent.provider ?? DEFAULT_DISCUSS_PROVIDER,
  });
}

const bidders = Object.entries(state.current_bids).filter(([, score]) => score === null);
await this.collectSpeech(sessionId, result.winner, ctx);
```

Right:
```ts
if (agent.participation === 'observer' && agent.provider === undefined && agent.model === undefined) {
  continue;
}

const bidders = Object.entries(state.current_bids).filter(([name, score]) =>
  score === null && !this.isManualParticipant(session, name),
);

if (this.isManualParticipant(currentSession, result.winner)) {
  return;
}

manager.resumeLoop(sessionId, ctx);
```
