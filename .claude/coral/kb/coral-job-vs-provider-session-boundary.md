# Coral Job UUID and Provider Session ID Are Distinct Handles

## Rule
The Coral job/session UUID (returned immediately by `launchJob()`) and the provider conversation/thread ID are two separate handles with different lifecycles. Workflow, wait, abort, and progress all operate on the Coral UUID. The provider conversation ID may arrive later or never (non-resumable paths). Any execution contract or redesign that collapses these into one field will either lose async control semantics or reintroduce them as ad hoc side channels.

## Why
If a rewrite conflates the two IDs into a single `conversation` field, callers lose the ability to abort or poll a running job before the provider has confirmed its thread ID. The `non_resumable` path never sets a provider ID at all — callers must still be able to track those jobs. The distinction is not an implementation artifact; it reflects two different things: "this Coral job exists" vs "the provider accepted this job and assigned it a thread".

## Pattern
Right:
```typescript
// Coral UUID — available immediately, used for all control operations
const coralSession = launchJob(args);
// Provider thread ID — may arrive later via status.json, may be absent
const providerThreadId = await waitForProviderAck(coralSession);
```

Wrong:
```typescript
// Collapsing both into one field loses the async control window
const conversation = await launch(args); // blocks until provider acks
abort(conversation.id); // no way to abort before provider responds
```
