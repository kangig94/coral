# Direct-Control Discuss Behaviors Need Shared Contracts
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
When discuss control moves into a backend manager, any behavior visible to synthesis, watch streams, transcript rendering, or `/bid`-style human participation must be modeled as an explicit shared contract. Do not leave targeted follow-up answers or observer participation as manager-private behavior: follow-up turns need a persisted first-class record, and `discuss_participate`-style tools need a typed response contract plus server-side turn validation if they replace older state-read flows.
## Why
These migrations look like pure orchestration refactors, so it is tempting to keep new behavior inside the manager and "just persist something later." That breaks in two ways. First, reusing normal speech/state-machine paths for post-convergence follow-ups corrupts step, quota, or bidding invariants because those answers are not ordinary speeches. Second, replacing a legacy user flow with an input-only tool leaves the skill migration underspecified: the old flow depended on explicit `speak` / `listen` / `session_ended` outcomes and a turn-ownership check before speech submission.
## Pattern
Wrong:
```md
- `must_answer` follow-ups are persisted into the transcript/audit path somehow
- `discuss_participate({ session, agent_name, score?, thought?, content? })`
```

Right:
```md
- `must_answer` follow-ups persist as a dedicated follow-up record or transcript entry that synthesis/watch can consume without using normal `speech` state transitions
- `discuss_participate` defines bid and speech response unions explicitly
- speech submission validates turn ownership server-side so `/bid` does not need a raw state tool only to check `current_speaker`
```
