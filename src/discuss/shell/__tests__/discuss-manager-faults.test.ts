import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '../../events.js';
import * as discussLoop from '../../shell/loop.js';
import * as discussBidFlow from '../../shell/bid-flow.js';
import { recoverPersistedSessionsFromStore } from '../../shell/operations.js';
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

describe('Discuss faults and retry recovery', () => {
  it('treats a speech wait timeout as a persisted speech timeout', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'exec-alpha' });
    const waitStreamOnce = vi.fn().mockRejectedValue(new Error('Job timed out waiting for terminal result'));
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
    const timeoutEntry = snapshot?.state.transcript.at(-1);
    expect(timeoutEntry?.type).toBe('speech');
    if (timeoutEntry?.type === 'speech') {
      expect(timeoutEntry.content).toContain('(alpha) timed out without delivering a speech.');
    }
  });

  it('soft-expels a failed cold-start bidder without wiping a healthy committed bid', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'exec-beta' });
    const waitStreamOnce = vi.fn().mockRejectedValue(new Error('resume failed'));
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
          { agent: 'alpha', score: 88, thought: 'alpha' },
        ),
      ],
    });

    await discussBidFlow.collectBids(harness.context, 'discuss-1', harness.ctx);

    const snapshot = harness.store.load('discuss-1');
    expect(snapshot?.state.current_bids).toEqual({ alpha: 88, beta: 0 });
    expect(snapshot?.state.current_thoughts).toEqual({ alpha: 'alpha', beta: '' });
    expect(snapshot?.state.agents.beta?.banned).toBe(false);
  });

  it('restarts malformed bid retries from the persisted attempt counter', async () => {
    const resume = vi.fn().mockResolvedValue({ status: 'running', job: 'job-2', session: 'exec-alpha' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: '{"score": 66, "thought": "second attempt"}',
      continuity: null,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ resume, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
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
          'agent.run.bound',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', executionSessionId: 'exec-alpha' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'agent.job.started',
          '2026-03-10T00:01:01.000Z',
          { agent: 'alpha', jobId: 'job-1', purpose: 'bid', attempt: 1 },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'agent.job.finished',
          '2026-03-10T00:01:02.000Z',
          { agent: 'alpha', jobId: 'job-1', outcome: 'retryable_parse_error', attempt: 1 },
        ),
      ],
    });

    await discussBidFlow.collectBids(harness.context, 'discuss-1', harness.ctx);

    const snapshot = harness.store.load('discuss-1');
    expect(resume).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        sessionId: 'exec-alpha',
        pool: 'discuss',
      }),
      harness.ctx,
    );
    expect(snapshot?.state.current_bids).toEqual({ alpha: 66, user: null });
    expect(snapshot?.runtime.agentRuns.alpha.currentAttempt).toBe(2);
    expect(snapshot?.runtime.agentRuns.alpha.lastAttemptOutcome).toBe('completed');
  });

  it('after recovery attach, resumeLoop re-runs a missing bid job against the persisted execution session id', async () => {
    const resume = vi.fn().mockResolvedValue({ status: 'running', job: 'job-2', session: 'exec-alpha' });
    const waitStreamOnce = vi.fn().mockImplementation(async () => {
      queueMicrotask(() => {
        getSession(harness.context, 'discuss-1')?.controller.abort();
      });
      return {
        content: '{"score": 58, "thought": "recovered bid"}',
        continuity: null,
      };
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ resume, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
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
          'agent.run.bound',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', executionSessionId: 'exec-alpha' },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'agent.job.started',
          '2026-03-10T00:01:01.000Z',
          { agent: 'alpha', jobId: 'job-missing', purpose: 'bid', attempt: 1 },
        ),
      ],
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
    expect(snapshot?.state.current_bids).toEqual({ alpha: 58, user: null });
    expect(snapshot?.runtime.agentRuns.alpha.currentAttempt).toBe(2);
    expect(snapshot?.runtime.agentRuns.alpha.lastAttemptOutcome).toBe('completed');
  });
});
