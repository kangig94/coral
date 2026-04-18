# Test Migration Notes

- `src/execution/__tests__/recovery-core.test.ts` -> `src/jobs/reconcile/__tests__/plan.test.ts`
- `src/execution/__tests__/abort-registry.test.ts` -> `src/jobs/shell/__tests__/abort-registry.test.ts`
- `src/execution/__tests__/agent-resolution.test.ts` -> `src/jobs/shell/__tests__/agent-resolution.test.ts`
- `src/execution/__tests__/session-manager.test.ts` -> split between `src/sessions/shell/__tests__/store.test.ts` and `src/sessions/shell/__tests__/resolve.test.ts`
- `src/client/__tests__/readers.test.ts` -> kept in place; still covers the shared session-entry reader bridge onto `src/sessions/entry.ts`
- Discuss slice:
- `src/execution/__tests__/discuss-session-store.test.ts` -> kept with import rewrites onto `src/discuss/shell/session-store.ts`; golden reducer coverage added at `src/discuss/__tests__/session-store-golden.test.ts`
- `src/execution/__tests__/discuss-manager.test.ts` -> kept with import rewrites onto `src/discuss/shell/{live-registry,runtime-build,operations,registry,subflows}.ts`
- `src/execution/__tests__/discuss-manager-{bids,speech,epoch,synthesis,faults,lifecycle}.test.ts` -> kept with import rewrites onto `src/discuss/shell/*`
- `src/execution/__tests__/discuss-tools.test.ts` and `src/execution/__tests__/discuss-prompts.test.ts` -> kept with import rewrites onto `src/discuss/shell/{tools,prompts}.ts`
- `src/execution/__tests__/discuss-runtime-sealing.test.ts` and `src/execution/__tests__/server-discuss-api.test.ts` -> kept with import rewrites onto `src/discuss/shell/*`
