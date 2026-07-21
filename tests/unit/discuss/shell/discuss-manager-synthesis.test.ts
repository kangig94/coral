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
import { testProjectPrincipal } from '#tests/helpers/principal.js';

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
      principal: testProjectPrincipal(snapshot.projectRoot),
      providerCredentials: snapshot.providerCredentials ?? harness.ctx.providerCredentials,
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

  it('discards every bound agent session log once the discussion is fully synthesized', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'synth-session' });
    const resume = vi.fn().mockResolvedValue({ status: 'running', job: 'job-r', session: 'synth-session' });
    const waitStreamOnce = vi.fn().mockResolvedValue({ content: 'Final synthesis.', continuity: null });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, resume, waitStreamOnce }));
    // Unit shim for the lifecycle-reactor.discardSessionArtifacts that
    // createCoordinatorCore wires into the context in production.
    const discardSessionArtifacts = vi.fn().mockResolvedValue(undefined);
    harness.context.discardSessionArtifacts = discardSessionArtifacts;
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'agent.run.bound',
          '2026-03-10T00:00:58.000Z',
          { agent: 'alpha', executionSessionId: 'alpha-session' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'agent.run.bound',
          '2026-03-10T00:00:59.000Z',
          { agent: 'beta', executionSessionId: 'beta-session' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'session.ended',
          '2026-03-10T00:01:00.000Z',
          { endReason: 'all_blocked', endReasonContent: 'All blocked.' },
        ),
      ],
    });

    await handleSynthesis(harness.context, 'discuss-1', harness.ctx);

    const discarded = discardSessionArtifacts.mock.calls.map((call) => call[0]);
    expect(discarded).toEqual(expect.arrayContaining(['alpha-session', 'beta-session']));
  });

  it('retains bound agent session logs when completed-discussion export fails', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'synth-session' });
    const resume = vi.fn().mockResolvedValue({ status: 'running', job: 'job-r', session: 'alpha-session' });
    const waitStreamOnce = vi.fn().mockResolvedValue({ content: 'Final synthesis.', continuity: null });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, resume, waitStreamOnce }));
    const discardSessionArtifacts = vi.fn().mockResolvedValue(undefined);
    harness.context.discardSessionArtifacts = discardSessionArtifacts;
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
          { agent: 'alpha', executionSessionId: 'alpha-session' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
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
    expect(discardSessionArtifacts).not.toHaveBeenCalled();
    expect(getSession(harness.context, 'discuss-export-failure')).toBeUndefined();
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

  it('finalizes with a fallback synthesis when no facilitator agent is available', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'expelled-required-discuss',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'participants.expelled',
          '2026-03-10T00:00:59.000Z',
          { agents: ['alpha', 'beta'], isRespawn: false },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'session.ended',
          '2026-03-10T00:01:00.000Z',
          { endReason: 'no_participants', endReasonContent: 'No eligible agents remaining. Ending discussion.' },
        ),
      ],
    });

    await handleSynthesis(harness.context, 'expelled-required-discuss', harness.ctx);

    const snapshot = harness.store.load('expelled-required-discuss');
    expect(snapshot?.runtime.controlPhase).toBe('idle');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
    });
    const synthesis = snapshot?.state.transcript.at(-1);
    expect(synthesis?.type === 'session_event' ? synthesis.detail : '').toContain(
      'Automatic final synthesis could not be generated.',
    );
    expect(getSession(harness.context, 'expelled-required-discuss')).toBeUndefined();
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
