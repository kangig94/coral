import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '#src/discuss/events.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import * as discussBidFlow from '#src/discuss/shell/flow/bid.js';
import { recoverPersistedSessionsFromStore } from '#src/discuss/shell/recovery.js';
import { getSession, getWatchState } from '#src/discuss/shell/registry.js';
import * as discussSpeechFlow from '#src/discuss/shell/flow/speech.js';
import { submitManualSpeech } from '#src/discuss/shell/operations.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
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
      projectRoot: fixtureCanonicalWorkDir(snapshot.projectRoot),
      pluginRoot: harness.ctx.pluginRoot,
      coralEnv: {},
      principal: testProjectPrincipal(snapshot.projectRoot),
      providerScope: snapshot.providerScope ?? harness.ctx.providerScope,
    }),
  );
}

function resumeRecoveredSessions(recovered: Awaited<ReturnType<typeof recoverSessions>>): void {
  for (const session of recovered) {
    discussLoop.resumeLoop(session.ctx, session.sessionId, session.invocationCtx);
  }
}

describe('Discuss speech collection', () => {
  it('records a successful speech and emits a derived speech_done watch event', async () => {
    const start = vi
      .fn()
      .mockResolvedValue({ kind: 'provider-session', status: 'running', jobId: 'job-1', sessionId: 'exec-alpha' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'Pedestrianization should start with the transit-heavy core and freight exemptions.',
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
          'bid.submitted',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', score: 80, thought: 'alpha' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-10T00:01:01.000Z',
          { agent: 'beta', score: 70, thought: 'beta' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-10T00:01:02.000Z',
          {
            allBids: { alpha: 80, beta: 70 },
            effectiveBids: { alpha: 80, beta: 70 },
            thoughts: { alpha: 'alpha', beta: 'beta' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
      ],
    });

    await discussSpeechFlow.collectSpeech(harness.context, 'discuss-1', 'alpha', harness.ctx);

    const snapshot = harness.store.load('discuss-1');
    expect(snapshot?.state.status).toBe('bidding');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'speech',
      agent: 'alpha',
      content: 'Pedestrianization should start with the transit-heavy core and freight exemptions.',
    });
    expect(getWatchState(harness.context, 'discuss-1').events.at(-1)).toMatchObject({
      type: 'speech_done',
      data: {
        speaker: 'alpha',
        content: 'Pedestrianization should start with the transit-heavy core and freight exemptions.',
      },
    });
    expect(getWatchState(harness.context, 'discuss-1').events.at(-1)?.ts).toEqual(expect.any(Number));
  });

  it('retries an empty speech once and persists only the accepted content', async () => {
    const start = vi
      .fn()
      .mockResolvedValue({ kind: 'provider-session', status: 'running', jobId: 'job-1', sessionId: 'exec-alpha' });
    const resume = vi
      .fn()
      .mockResolvedValue({ kind: 'provider-session', status: 'running', jobId: 'job-2', sessionId: 'exec-alpha' });
    const waitStreamOnce = vi
      .fn()
      .mockResolvedValueOnce({
        content: '   ',
        continuity: null,
      })
      .mockResolvedValueOnce({
        content: '  Final speech.  ',
        continuity: null,
      });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, resume, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-empty-retry',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', score: 80, thought: 'alpha' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-10T00:01:01.000Z',
          { agent: 'beta', score: 70, thought: 'beta' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-10T00:01:02.000Z',
          {
            allBids: { alpha: 80, beta: 70 },
            effectiveBids: { alpha: 80, beta: 70 },
            thoughts: { alpha: 'alpha', beta: 'beta' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
      ],
    });

    await discussSpeechFlow.collectSpeech(harness.context, 'discuss-empty-retry', 'alpha', harness.ctx);

    const snapshot = harness.store.load('discuss-empty-retry');
    const finishedOutcomes = harness.store
      .readSessionEvents('discuss-empty-retry')
      .filter((event) => event.kind === 'agent.job.finished')
      .map((event) => event.payload.outcome);
    expect(start).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        sessionId: 'exec-alpha',
        pool: 'discuss',
        owner: { kind: 'discussion', id: 'discuss-empty-retry' },
      }),
      harness.ctx,
    );
    expect(snapshot?.state.status).toBe('bidding');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'speech',
      agent: 'alpha',
      content: 'Final speech.',
    });
    expect(snapshot?.runtime.agentRuns.alpha.currentAttempt).toBe(2);
    expect(snapshot?.runtime.agentRuns.alpha.currentJobId).toBeUndefined();
    expect(snapshot?.runtime.agentRuns.alpha.lastAttemptOutcome).toBe('completed');
    expect(finishedOutcomes).toEqual(['retryable_parse_error', 'completed']);
  });

  it('after recovery attach, resumeLoop resumes a persisted speech job before reopening bidding', async () => {
    const resume = vi.fn().mockResolvedValue({
      kind: 'provider-session',
      status: 'running',
      jobId: 'job-2',
      sessionId: 'exec-alpha',
    });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'Start with the transit-heavy core.',
      continuity: null,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ resume, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', score: 80, thought: 'alpha' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-10T00:01:01.000Z',
          { agent: 'beta', score: 70, thought: 'beta' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-10T00:01:02.000Z',
          {
            allBids: { alpha: 80, beta: 70 },
            effectiveBids: { alpha: 80, beta: 70 },
            thoughts: { alpha: 'alpha', beta: 'beta' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 4,
          'agent.run.bound',
          '2026-03-10T00:01:03.000Z',
          { agent: 'alpha', executionSessionId: 'exec-alpha' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 5,
          'agent.job.started',
          '2026-03-10T00:01:04.000Z',
          { agent: 'alpha', jobId: 'job-1', purpose: 'speech', attempt: 1 },
        ),
      ],
    });
    vi.spyOn(discussBidFlow, 'collectBids').mockImplementation(async () => {
      getSession(harness.context, 'discuss-1')?.controller.abort();
      return { shouldResume: false };
    });
    const recovered = await recoverSessions(harness);
    expect(recovered).toHaveLength(1);
    resumeRecoveredSessions(recovered);
    await advanceDiscussRuntime(harness, 1);

    const snapshot = harness.store.load('discuss-1');
    expect(resume).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        sessionId: 'exec-alpha',
        pool: 'discuss',
        owner: { kind: 'discussion', id: 'discuss-1' },
      }),
      harness.ctx,
    );
    expect(snapshot?.state.status).toBe('bidding');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'speech',
      agent: 'alpha',
      content: 'Start with the transit-heavy core.',
    });
  });

  it('accepts a manual speech alias during the shell turn pre-check', async () => {
    const harness = createDiscussHarness();
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => undefined);
    await persistSession(harness, {
      sessionId: 'discuss-manual-alias',
      recover: true,
      agents: [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', score: 80, thought: 'alpha' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'bid.submitted',
          '2026-03-10T00:01:01.000Z',
          { agent: 'user', score: 95, thought: 'observer bid' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'bid.round.closed',
          '2026-03-10T00:01:02.000Z',
          {
            allBids: { alpha: 80, user: 95 },
            effectiveBids: { alpha: 80, user: 95 },
            thoughts: { alpha: 'alpha', user: 'observer bid' },
            outcome: { winner: 'user', speaker_type: 'cold_start' as const },
            stateMutations: { cold_start: false },
          },
        ),
      ],
    });

    const result = await submitManualSpeech(
      harness.context,
      'discuss-manual-alias',
      'user-1',
      'Use timed loading windows before a full pedestrian zone.',
      harness.ctx,
    );

    expect(result).toEqual({ action: 'speech_recorded' });
    expect(harness.store.load('discuss-manual-alias')?.state.transcript.at(-1)).toMatchObject({
      type: 'speech',
      agent: 'user',
      content: 'Use timed loading windows before a full pedestrian zone.',
    });
  });
});
