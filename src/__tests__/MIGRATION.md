# Test Migration Notes

- `src/execution/__tests__/recovery-core.test.ts` -> `src/jobs/reconcile/__tests__/plan.test.ts`
- `src/execution/__tests__/abort-registry.test.ts` -> `src/jobs/shell/__tests__/abort-registry.test.ts`
- `src/execution/__tests__/agent-resolution.test.ts` -> `src/jobs/shell/__tests__/agent-resolution.test.ts`
- `src/execution/__tests__/session-manager.test.ts` -> split between `src/sessions/shell/__tests__/store.test.ts` and `src/sessions/shell/__tests__/resolve.test.ts`
- `src/client/__tests__/readers.test.ts` -> kept in place; still covers the shared session-entry reader bridge onto `src/sessions/entry.ts`
