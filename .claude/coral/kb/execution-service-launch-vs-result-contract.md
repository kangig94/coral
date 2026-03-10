# Execution Service Is An Async Launcher, Not A Sync Model API
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
Any backend orchestrator built on `ExecutionService` must model `start()`, `resume()`, and `coralDispatch()` as asynchronous launch operations that return `LaunchDecision`, with model output collected later through `waitStream()` or an equivalent result helper. It must also respect that `ExecutionService` instances are scoped by `projectRoot`; designs that inject one global service or key long-lived state only by `sessionId` are incomplete.
## Why
If a plan assumes `ExecutionService` returns content directly, it will write bid/speech logic that has nowhere to get the actual text, and it will miss queued outcomes, progress monitoring, and terminal-result collection. If it also ignores project-root scoping, abort routing and session ownership drift: one singleton manager can launch jobs through an unregistered service, pin sessions to the wrong root, or collide on project-scoped identifiers.
## Pattern
Right:
```typescript
const service = getExecutionService(ctx);
const launch = await service.coralDispatch(provider, 'worker', { prompt, sessionId }, ctx);
if (launch.status === 'rejected') return fail(launch.message);

const result = await waitForSingleResult(service, launch.job);
return result.content;
```

```typescript
function getOrCreateDiscussManager(projectRoot: string): DiscussManager {
  // Manager ownership matches the ExecutionService/project root boundary.
}
```

Wrong:
```typescript
const result = await service.coralDispatch(provider, 'worker', { prompt }, ctx);
const parsed = JSON.parse(result.content); // LaunchDecision has no content
```

```typescript
const manager = new DiscussManager(globalExecutionService);
sessions.set(sessionId, discussSession); // sessionId alone is enough
```
