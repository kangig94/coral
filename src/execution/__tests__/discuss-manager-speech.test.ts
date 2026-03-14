// @flaky — parallel shared-state interference; run in isolation with retry
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '../../discuss/events.js';
import * as discussPrompts from '../discuss-prompts.js';
import * as discussLoop from '../discuss-loop.js';
import * as discussSubflows from '../discuss-subflows.js';
import { getWatchState, recoverPersistedSessions } from '../discuss-operations.js';
import { getSession } from '../discuss-registry.js';
import {
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  persistSession,
} from './discuss-test-helpers.js';

afterEach(() => {
  cleanupDiscussHarnesses();
  vi.clearAllTimers();
  vi.restoreAllMocks();
});

describe('Discuss speech collection', { retry: 2 }, () => {
  it('records a successful speech and emits a derived speech_done watch event', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'exec-alpha' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'Pedestrianization should start with the transit-heavy core and freight exemptions.',
      nonResumable: false,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.submitted', '2026-03-10T00:01:00.000Z', { agent: 'alpha', score: 80, thought: 'alpha' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'bid.submitted', '2026-03-10T00:01:01.000Z', { agent: 'beta', score: 70, thought: 'beta' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-10T00:01:02.000Z', {
          allBids: { alpha: 80, beta: 70 },
          effectiveBids: { alpha: 80, beta: 70 },
          thoughts: { alpha: 'alpha', beta: 'beta' },
          outcome: { winner: 'alpha', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
      ],
    });

    await discussSubflows.collectSpeech(harness.context, 'discuss-1', 'alpha', harness.ctx);

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

  it('passes prior speech only to listeners during the next bid collection', async () => {
    const start = vi.fn()
      .mockResolvedValueOnce({ status: 'running', job: 'job-1', session: 'exec-alpha' })
      .mockResolvedValueOnce({ status: 'running', job: 'job-2', session: 'exec-beta' });
    const waitStreamOnce = vi.fn()
      .mockResolvedValueOnce({ content: '{"score": 44, "thought": "alpha"}', nonResumable: false })
      .mockResolvedValueOnce({ content: '{"score": 58, "thought": "beta"}', nonResumable: false });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.submitted', '2026-03-10T00:01:00.000Z', { agent: 'alpha', score: 80, thought: 'alpha' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'bid.submitted', '2026-03-10T00:01:01.000Z', { agent: 'beta', score: 70, thought: 'beta' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-10T00:01:02.000Z', {
          allBids: { alpha: 80, beta: 70 },
          effectiveBids: { alpha: 80, beta: 70 },
          thoughts: { alpha: 'alpha', beta: 'beta' },
          outcome: { winner: 'alpha', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 4, 'speech.recorded', '2026-03-10T00:01:03.000Z', {
          agent: 'alpha',
          content: 'We need to talk about freight access before setting a ban.',
          decrementQuota: true,
          recordLastSpeechStep: 1,
        }),
      ],
    });

    const realBuildBidPrompt = discussPrompts.buildBidPrompt;
    const buildBidPromptSpy = vi.spyOn(discussPrompts, 'buildBidPrompt').mockImplementation((promptCtx) =>
      realBuildBidPrompt(promptCtx),
    );

    await discussSubflows.collectBids(harness.context, 'discuss-1', harness.ctx);

    const alphaCall = buildBidPromptSpy.mock.calls
      .map(([promptCtx]) => promptCtx)
      .find((promptCtx) => promptCtx.selfName === 'alpha');
    const betaCall = buildBidPromptSpy.mock.calls
      .map(([promptCtx]) => promptCtx)
      .find((promptCtx) => promptCtx.selfName === 'beta');

    expect(alphaCall?.priorSpeech).toBeNull();
    expect(betaCall?.priorSpeech).toEqual({
      speaker: 'alpha',
      content: 'We need to talk about freight access before setting a ban.',
    });
  });

  it('after recovery attach, resumeLoop resumes a persisted speech job before reopening bidding', async () => {
    const resume = vi.fn().mockResolvedValue({
      status: 'running',
      job: 'job-2',
      session: 'exec-alpha',
    });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'Start with the transit-heavy core.',
      nonResumable: false,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ resume, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.submitted', '2026-03-10T00:01:00.000Z', { agent: 'alpha', score: 80, thought: 'alpha' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'bid.submitted', '2026-03-10T00:01:01.000Z', { agent: 'beta', score: 70, thought: 'beta' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 3, 'bid.round.closed', '2026-03-10T00:01:02.000Z', {
          allBids: { alpha: 80, beta: 70 },
          effectiveBids: { alpha: 80, beta: 70 },
          thoughts: { alpha: 'alpha', beta: 'beta' },
          outcome: { winner: 'alpha', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 4, 'agent.run.bound', '2026-03-10T00:01:03.000Z', { agent: 'alpha', executionSessionId: 'exec-alpha' }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 5, 'agent.job.started', '2026-03-10T00:01:04.000Z', { agent: 'alpha', jobId: 'job-1', purpose: 'speech', attempt: 1 }),
      ],
    });
    vi.spyOn(discussSubflows, 'collectBids').mockImplementation(async () => {
      getSession(harness.context, 'discuss-1')?.controller.abort();
      return { shouldResume: false };
    });

    vi.useFakeTimers();
    await recoverPersistedSessions(harness.context, harness.ctx);
    discussLoop.resumeLoop(harness.context, 'discuss-1', harness.ctx);
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    const snapshot = harness.store.load('discuss-1');
    expect(resume).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'exec-alpha',
      pool: 'discuss',
    }), harness.ctx);
    expect(snapshot?.state.status).toBe('bidding');
    expect(snapshot?.state.transcript.at(-1)).toMatchObject({
      type: 'speech',
      agent: 'alpha',
      content: 'Start with the transit-heavy core.',
    });
  });
});
