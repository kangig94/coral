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

async function recoverSessions(harness: DiscussHarness): Promise<void> {
  await recoverPersistedSessionsFromStore(harness.store, () => harness.context);
}

describe('Discuss synthesis', () => {
  it('records a single synthesis entry from a terminal session', async () => {
    const start = vi.fn().mockResolvedValue({
      kind: 'provider-session',
      status: 'running',
      jobId: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d',
      requestedSeq: 1,
      epochKey: 'test-epoch',
    });
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

  it('retains bound agent session logs when completed-discussion export fails', async () => {
    const start = vi.fn().mockResolvedValue({
      kind: 'provider-session',
      status: 'running',
      jobId: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d',
      requestedSeq: 1,
      epochKey: 'test-epoch',
    });
    const resume = vi.fn().mockResolvedValue({
      kind: 'provider-session',
      status: 'running',
      jobId: '6960e368-4c7c-5e5a-95e2-6c9de7df59f8',
      requestedSeq: 1,
      epochKey: 'test-epoch',
    });
    const waitStreamOnce = vi.fn().mockResolvedValue({ content: 'Final synthesis.', continuity: null });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, resume, waitStreamOnce }));
    const discardConversationArtifacts = vi.fn().mockResolvedValue(undefined);
    harness.context.discardConversationArtifacts = discardConversationArtifacts;
    vi.spyOn(harness.runtime.storage, 'writeAtomicSync').mockReturnValue(false);
    await persistSession(harness, {
      sessionId: 'discuss-export-failure',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'agent.run.bound',
          '2026-03-10T00:00:58.000Z',
          { agent: 'alpha', jobId: '6960e368-4c7c-5e5a-95e2-6c9de7df59f8' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'agent.job.started',
          '2026-03-10T00:00:58.100Z',
          { agent: 'alpha', jobId: '6960e368-4c7c-5e5a-95e2-6c9de7df59f8', execution: 1, purpose: 'bid', attempt: 1 },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'agent.job.finished',
          '2026-03-10T00:00:58.200Z',
          {
            agent: 'alpha',
            jobId: '6960e368-4c7c-5e5a-95e2-6c9de7df59f8',
            execution: 1,
            outcome: 'completed',
            attempt: 1,
          },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 4,
          'session.ended',
          '2026-03-10T00:01:00.000Z',
          { endReason: 'all_blocked', endReasonContent: 'All blocked.' },
        ),
      ],
    });

    await handleSynthesis(harness.context, 'discuss-export-failure', harness.ctx);

    const snapshot = harness.store.load('discuss-export-failure');
    expect(snapshot?.runtime.controlPhase).toBe('idle');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
      detail: 'Final synthesis.',
    });
    expect(discardConversationArtifacts).not.toHaveBeenCalled();
    expect(getSession(harness.context, 'discuss-export-failure')).toBeUndefined();
  });

  it('after recovery attach, resumeLoop resumes synthesis for ended sessions that have not been synthesized yet', async () => {
    const start = vi.fn().mockResolvedValue({
      kind: 'provider-session',
      status: 'running',
      jobId: 'f10f3e57-0d04-53df-b4c3-3bcf75a1222d',
      requestedSeq: 1,
      epochKey: 'test-epoch',
    });
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
    await recoverSessions(harness);
    expect(getSession(harness.context, 'discuss-1')).toBeDefined();
    discussLoop.resumeLoop(harness.context, 'discuss-1', harness.ctx);
    await advanceDiscussRuntime(harness, 1);

    const snapshot = harness.store.load('discuss-1');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
      detail: 'Recovered synthesis text.',
    });
    expect(getSession(harness.context, 'discuss-1')).toBeUndefined();
  });

  it('finalizes with a fallback synthesis when the synthesis provider fails', async () => {
    const start = vi.fn().mockRejectedValue(new Error('claude dispatch failed'));
    const harness = createDiscussHarness(createExecutionServiceStub({ start }));
    await persistSession(harness, {
      sessionId: 'provider-failure-discuss',
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

    await handleSynthesis(harness.context, 'provider-failure-discuss', harness.ctx);

    const snapshot = harness.store.load('provider-failure-discuss');
    const synthesis = snapshot?.state.transcript.at(-1);
    expect(snapshot?.runtime.controlPhase).toBe('idle');
    expect(synthesis?.type === 'session_event' ? synthesis.detail : '').toContain('claude dispatch failed');
    expect(getSession(harness.context, 'provider-failure-discuss')).toBeUndefined();
  });
});
