import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '#src/discuss/events.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import { recoverPersistedSessionsFromStore } from '#src/discuss/shell/recovery.js';
import { getSession } from '#src/discuss/shell/registry.js';
import { handleSynthesis } from '#src/discuss/shell/flow/synthesis.js';
import {
  advanceDiscussRuntime,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  persistSession,
  type DiscussHarness,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';

afterEach(() => {
  cleanupDiscussHarnesses();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function recoverSessions(harness: DiscussHarness) {
  return recoverPersistedSessionsFromStore(
    harness.store,
    () => harness.context,
    (snapshot) => ({
      projectRoot: snapshot.projectRoot,
      pluginRoot: harness.ctx.pluginRoot,
      coralEnv: {},
    }),
  );
}

function resumeRecoveredSessions(recovered: Awaited<ReturnType<typeof recoverSessions>>): void {
  for (const session of recovered) {
    discussLoop.resumeLoop(session.ctx, session.sessionId, session.invocationCtx);
  }
}

describe('Discuss synthesis', () => {
  it('records a single synthesis entry from a terminal session', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'synth-session' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'The panel supported a phased pedestrianization plan centered on transit access.',
      continuity: null,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'session.ended',
          '2026-03-10T00:01:00.000Z',
          { endReason: 'all_blocked', endReasonContent: 'All blocked.' },
        ),
      ],
    });

    await handleSynthesis(harness.context, 'discuss-1', harness.ctx);

    const snapshot = harness.store.load('discuss-1');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
      detail: 'The panel supported a phased pedestrianization plan centered on transit access.',
    });
  });

  it('after recovery attach, resumeLoop resumes synthesis for ended sessions that have not been synthesized yet', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'synth-session' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'Recovered synthesis text.',
      continuity: null,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'session.ended',
          '2026-03-10T00:01:00.000Z',
          { endReason: 'all_blocked', endReasonContent: 'All blocked.' },
        ),
      ],
    });
    const recovered = await recoverSessions(harness);
    expect(recovered).toHaveLength(1);
    resumeRecoveredSessions(recovered);
    await advanceDiscussRuntime(harness, 1);

    const snapshot = harness.store.load('discuss-1');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
      detail: 'Recovered synthesis text.',
    });
    expect(getSession(harness.context, 'discuss-1')).toBeUndefined();
  });
});
