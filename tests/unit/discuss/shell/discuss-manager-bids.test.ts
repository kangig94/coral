import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectBids } from '#src/discuss/shell/flow/bid.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import { startDiscussSession, submitManualBid } from '#src/discuss/shell/operations.js';
import { DiscussStaleWriteError } from '#src/discuss/shell/session-store.js';
import {
  DEFAULT_TOPIC,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  defaultAgents,
  persistSession,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';

afterEach(() => {
  cleanupDiscussHarnesses();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Discuss bid collection', () => {
  it('records valid JSON bids during session start', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running', job: 'job-1', session: 'exec-alpha' })
      .mockResolvedValueOnce({ status: 'running', job: 'job-2', session: 'exec-beta' });
    const waitStreamOnce = vi
      .fn()
      .mockResolvedValueOnce({
        content: '{"score": 61, "thought": "I should frame the tradeoff."}',
        continuity: null,
      })
      .mockResolvedValueOnce({
        content: '{"score": 37, "thought": "I have a narrower follow-up."}',
        continuity: null,
      });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));

    const session = await startDiscussSession(
      harness.context,
      'discuss-1',
      DEFAULT_TOPIC,
      [
        { name: 'alpha', persona: 'Alpha', provider: 'codex', model: 'gpt-5' },
        { name: 'beta', persona: 'Beta', provider: 'claude', model: 'sonnet' },
      ],
      { min_bid_delay_ms: 15 },
      harness.ctx,
    );

    expect(session.snapshot.state.status).toBe('bidding');
    expect(session.snapshot.state.current_bids).toEqual({ alpha: 61, beta: 37 });
    expect(session.snapshot.state.current_thoughts).toEqual({
      alpha: 'I should frame the tradeoff.',
      beta: 'I have a narrower follow-up.',
    });
    expect(session.snapshot.runtime.agentRuns.alpha).toMatchObject({ provider: 'codex', model: 'gpt-5' });
    expect(session.snapshot.runtime.agentRuns.beta).toMatchObject({ provider: 'claude', model: 'sonnet' });

    harness.cleanup();
  });

  it('retries malformed JSON and persists the second-attempt success', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'exec-alpha' });
    const resume = vi.fn().mockResolvedValue({ status: 'running', job: 'job-2', session: 'exec-alpha' });
    const waitStreamOnce = vi
      .fn()
      .mockResolvedValueOnce({ content: 'not json at all', continuity: null })
      .mockResolvedValueOnce({
        content: '```json\n{"score": 72, "thought": "The last speech missed costs."}\n```',
        continuity: null,
      });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, resume, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: true,
      agents: [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
    });

    await collectBids(harness.context, 'discuss-1', harness.ctx);

    const snapshot = harness.store.load('discuss-1');
    expect(start).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(snapshot?.state.current_bids).toEqual({ alpha: 72, user: null });
    expect(snapshot?.state.current_thoughts.alpha).toBe('The last speech missed costs.');
    expect(snapshot?.runtime.agentRuns.alpha.currentAttempt).toBe(2);
    expect(snapshot?.runtime.agentRuns.alpha.lastAttemptOutcome).toBe('completed');

    harness.cleanup();
  });

  it('revalidates provider bids after a manual observer advances the session seq', async () => {
    let releaseAlpha!: () => void;
    let releaseBeta!: () => void;
    const alphaReady = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    const betaReady = new Promise<void>((resolve) => {
      releaseBeta = resolve;
    });
    const start = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running', job: 'job-1', session: 'exec-alpha' })
      .mockResolvedValueOnce({ status: 'running', job: 'job-2', session: 'exec-beta' });
    const waitStreamOnce = vi
      .fn()
      .mockImplementationOnce(async () => {
        await alphaReady;
        return { content: '{"score": 61, "thought": "alpha"}', continuity: null };
      })
      .mockImplementationOnce(async () => {
        await betaReady;
        return { content: '{"score": 37, "thought": "beta"}', continuity: null };
      });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: true,
      agents: [...defaultAgents(), { name: 'user', persona: '# User', participation: 'observer' }],
    });

    const bidWork = collectBids(harness.context, 'discuss-1', harness.ctx);
    await Promise.resolve();
    await Promise.resolve();

    await submitManualBid(
      harness.context,
      'discuss-1',
      'user',
      63,
      'I need to answer the accessibility concern.',
      harness.ctx,
    );

    releaseAlpha();
    releaseBeta();
    await bidWork;

    const snapshot = harness.store.load('discuss-1');
    expect(snapshot?.state.current_bids).toEqual({ alpha: 61, beta: 37, user: 63 });
    expect(snapshot?.state.current_thoughts.user).toBe('I need to answer the accessibility concern.');

    harness.cleanup();
  });

  it('does not auto-bid for manual observer participants', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running', job: 'job-1', session: 'exec-alpha' })
      .mockResolvedValueOnce({ status: 'running', job: 'job-2', session: 'exec-beta' });
    const waitStreamOnce = vi
      .fn()
      .mockResolvedValueOnce({ content: '{"score": 61, "thought": "alpha"}', continuity: null })
      .mockResolvedValueOnce({ content: '{"score": 37, "thought": "beta"}', continuity: null });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));

    const session = await startDiscussSession(
      harness.context,
      'discuss-1',
      DEFAULT_TOPIC,
      [
        { name: 'alpha', persona: 'Alpha', provider: 'codex' },
        { name: 'beta', persona: 'Beta', provider: 'codex' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      { min_bid_delay_ms: 1000 },
      harness.ctx,
    );

    expect(session.snapshot.state.current_bids.user).toBeNull();
    expect(session.snapshot.runtime.agentRuns.user).toBeUndefined();

    harness.cleanup();
  });

  it('keeps start successful when provider launch throws during initial bid collection', async () => {
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => undefined);
    const start = vi.fn().mockRejectedValue(new Error('provider process unavailable'));
    const harness = createDiscussHarness(createExecutionServiceStub({ start }));

    const session = await startDiscussSession(
      harness.context,
      'launch-throw-discuss',
      DEFAULT_TOPIC,
      defaultAgents().map((agent) => ({ ...agent, provider: 'claude' })),
      {},
      harness.ctx,
    );

    expect(session.snapshot.sessionId).toBe('launch-throw-discuss');
    expect(session.snapshot.state.status).toBe('ended');
    expect(session.snapshot.state.end_reason_content).toContain('No eligible agents');

    harness.cleanup();
  });

  it('converts post-launch runtime persistence failure into bid failure instead of throwing', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ status: 'running', job: 'job-1', session: 'exec-alpha' })
      .mockResolvedValueOnce({ status: 'running', job: 'job-2', session: 'exec-beta' });
    const waitStreamOnce = vi.fn();
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    const originalAppend = harness.store.append.bind(harness.store);
    const append = vi.spyOn(harness.store, 'append');
    append.mockImplementation(async (sessionId, expectedSeq, events) => {
      if (events.some((event) => event.kind === 'agent.run.bound' || event.kind === 'agent.job.started')) {
        throw new DiscussStaleWriteError(expectedSeq ?? 0, expectedSeq ?? 0);
      }
      return originalAppend(sessionId, expectedSeq, events);
    });

    const session = await startDiscussSession(
      harness.context,
      'runtime-persist-failure-discuss',
      DEFAULT_TOPIC,
      defaultAgents().map((agent) => ({ ...agent, provider: 'claude' })),
      {},
      harness.ctx,
    );

    expect(session.snapshot.state.status).toBe('ended');
    expect(waitStreamOnce).not.toHaveBeenCalled();
    expect(session.snapshot.state.end_reason_content).toContain('No eligible agents');

    harness.cleanup();
  });
});
