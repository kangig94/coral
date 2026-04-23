// @flaky — parallel shared-state interference; run in isolation with retry
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '../../events.js';
import * as discussPrompts from '../../shell/prompts.js';
import * as discussLoop from '../../shell/loop.js';
import * as discussBidFlow from '../../shell/bid-flow.js';
import { getWatchState, recoverPersistedSessionsFromStore } from '../../shell/operations.js';
import { getSession } from '../../shell/registry.js';
import * as discussSpeechFlow from '../../shell/speech-flow.js';
import {
  advanceDiscussRuntime,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  persistSession,
  type DiscussHarness,
} from './discuss-test-helpers.js';

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

describe('Discuss speech collection', { retry: 2 }, () => {
  it('records a successful speech and emits a derived speech_done watch event', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'exec-alpha' });
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

  it('passes prior speech only to listeners during the next bid collection', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running', job: 'job-1', session: 'exec-alpha' })
      .mockResolvedValueOnce({ status: 'running', job: 'job-2', session: 'exec-beta' });
    const waitStreamOnce = vi
      .fn()
      .mockResolvedValueOnce({ content: '{"score": 44, "thought": "alpha"}', continuity: null })
      .mockResolvedValueOnce({ content: '{"score": 58, "thought": "beta"}', continuity: null });
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
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 4,
          'speech.recorded',
          '2026-03-10T00:01:03.000Z',
          {
            agent: 'alpha',
            content: 'We need to talk about freight access before setting a ban.',
            decrementQuota: true,
            recordLastSpeechStep: 1,
          },
        ),
      ],
    });

    const realBuildBidPrompt = discussPrompts.buildBidPrompt;
    const buildBidPromptSpy = vi
      .spyOn(discussPrompts, 'buildBidPrompt')
      .mockImplementation((promptCtx) => realBuildBidPrompt(promptCtx));

    await discussBidFlow.collectBids(harness.context, 'discuss-1', harness.ctx);

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

  it('attaches a recovered manual-observer speaker without adding it to the resume set', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-manual-speaker',
      recover: false,
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

    const recovered = await recoverSessions(harness);

    expect(recovered).toHaveLength(0);
    expect(getSession(harness.context, 'discuss-manual-speaker')?.snapshot.state).toMatchObject({
      status: 'speaking',
      current_speaker: 'user',
    });
  });
});
