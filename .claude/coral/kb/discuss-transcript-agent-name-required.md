# discuss_transcript Requires agent_name for Bid Enforcement

## Rule
Always include `agent_name` in every `discuss_transcript` call when participating as a named agent. Without it, the bid enforcement guard (`read_transcript_first`) will block all subsequent bids because the read is not stamped in `transcript_read_step`.

## Why
The `read_transcript_first` guard in `state-machine.ts` checks `transcript_read_step[agentName] >= state.step`. This value is only updated when `discuss_transcript` is called with `agent_name` explicitly set (see `server-handlers.ts` transcript handler). Calls without `agent_name` return content normally but do NOT stamp the read — making the agent perpetually blocked from bidding after the first speech is delivered.

## Pattern
```typescript
// WRONG — reads transcript but doesn't stamp readStep, bid will fail
discuss_transcript({ session, mode: "recent" })

// RIGHT — stamps transcript_read_step[agent], bid enforcement passes
discuss_transcript({ session, agent_name: "my-agent", mode: "recent" })
```

Real-world impact: In a live discussion session, an agent's bid was lost (fallback score inserted) because prior transcript reads omitted `agent_name`, making the enforcement system treat every subsequent bid as "hasn't read the transcript yet."
