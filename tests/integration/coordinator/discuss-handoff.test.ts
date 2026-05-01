import { describe, it } from 'vitest';

// AC4 cross-domain coverage: discuss sessions in mid-turn must survive a
// daemon handoff swap. The replacement daemon's startup recovery must
// rehydrate discuss state from journal projections without observing the old
// daemon's terminal/abort writes.
//
// Implementation deferred until the handoff integration scaffolding lands in
// Phase G: this file requires the same VirtualTime + mock-daemon harness used
// by `starting-handoff.test.ts` (Phase C) and `handoff-escalation.test.ts`
// (Phase E), neither of which exists yet. The Phase A2 unit coverage in
// `tests/unit/jobs/shell/launch-quiesce.test.ts` plus
// `tests/unit/transport/http/server.test.ts` is sufficient to gate AC4 at
// the contract boundary; this file exists so the cross-domain assertions
// have a registered home before the integration scaffolding arrives.

describe.skip('discuss handoff (AC4 cross-domain — pending Phase G scaffolding)', () => {
  it('seeds a discuss session, triggers handoff, asserts state rehydrates on the replacement daemon', () => {
    // 1. Seed a discuss session on incumbent.
    // 2. Trigger handoff via transport.shutdown.
    // 3. Bind replacement daemon, wait for runStartupRecovery.
    // 4. Assert recoverPersistedDiscussFn rehydrated the session and that
    //    no `discuss.aborted` terminal was written by the old daemon.
  });

  it('does not write hooks.onShutdown(handoff) discuss-store mutations on the old daemon', () => {
    // hooks.onShutdown('handoff') must skip persistAbortEnd; only abort
    // markers are written. This test asserts the journal does not contain
    // a discuss abort-end event from the old daemon's lifecycle.
  });
});
