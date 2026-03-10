import { afterEach, describe, expect, it, vi } from 'vitest';

import { initSession } from '../../discuss/state-machine.js';
import type { CallerContext, ExecutionService } from '../service.js';
import { DiscussManager } from '../discuss-manager.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
};

function createServiceStub(): ExecutionService {
  return Object.create(null) as ExecutionService;
}

function createState(sessionId: string) {
  return {
    ...initSession({
      topic: 'Should the city pedestrianize the downtown core?',
      agents: [
        { name: 'alpha', persona: 'Alpha', participation: 'required' },
        { name: 'beta', persona: 'Beta', participation: 'required' },
      ],
      min_bid_delay_ms: 0,
    }, '2026-03-10T00:00:00.000Z'),
    session_id: sessionId,
  };
}

function collectBids(manager: DiscussManager, sessionId: string, currentCtx: CallerContext): Promise<void> {
  return (manager as unknown as {
    collectBids(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
  }).collectBids(sessionId, currentCtx);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DiscussManager bid collection', () => {
  it('records valid JSON bids during session start', async () => {
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    vi.spyOn(manager, 'runAgentTurn')
      .mockResolvedValueOnce({ content: '{"score": 61, "thought": "I should frame the tradeoff."}', nonResumable: false })
      .mockResolvedValueOnce({ content: '{"score": 37, "thought": "I have a narrower follow-up."}', nonResumable: false });

    const session = await manager.start(
      'discuss-1',
      'Should the city pedestrianize the downtown core?',
      [
        { name: 'alpha', persona: 'Alpha', provider: 'codex', model: 'gpt-5' },
        { name: 'beta', persona: 'Beta', provider: 'claude', model: 'sonnet' },
      ],
      { min_bid_delay_ms: 15 },
      ctx,
    );

    expect(session.state.status).toBe('bidding');
    expect(session.state.session_id).toBe('discuss-1');
    expect(session.state.current_bids).toEqual({ alpha: 61, beta: 37 });
    expect(session.state.current_thoughts).toEqual({
      alpha: 'I should frame the tradeoff.',
      beta: 'I have a narrower follow-up.',
    });
    expect(session.agentRuns.get('alpha')).toMatchObject({ provider: 'codex', model: 'gpt-5' });
    expect(session.agentRuns.get('beta')).toMatchObject({ provider: 'claude', model: 'sonnet' });
    session.controller.abort();
  });

  it('retries malformed JSON and accepts a later valid response', async () => {
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const session = manager.createSession('discuss-1', {
      ...createState('discuss-1'),
      status: 'bidding',
      current_bids: { alpha: null, beta: 55 },
      current_thoughts: { beta: 'Already in.' },
      pending_bidders: ['alpha'],
    });
    session.agentRuns.set('alpha', { provider: 'codex' });

    const runAgentTurn = vi.spyOn(manager, 'runAgentTurn')
      .mockResolvedValueOnce({ content: 'not json at all', nonResumable: false })
      .mockResolvedValueOnce({ content: '```json\n{"score": 72, "thought": "The last speech missed costs."}\n```', nonResumable: false });

    await collectBids(manager, 'discuss-1', ctx);

    expect(runAgentTurn).toHaveBeenCalledTimes(2);
    expect(runAgentTurn.mock.calls[1]?.[4]).toContain('Previous response:');
    expect(runAgentTurn.mock.calls[1]?.[4]).toContain('not json at all');
    expect(session.state.current_bids).toEqual({ alpha: 72, beta: 55 });
    expect(session.state.current_thoughts).toEqual({
      alpha: 'The last speech missed costs.',
      beta: 'Already in.',
    });
  });

  it('ends the session when every cold-start bidder times out or crashes', async () => {
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    vi.spyOn(manager, 'runAgentTurn').mockRejectedValue(new Error('Job timed out waiting for terminal result'));

    const session = await manager.start(
      'discuss-1',
      'Should the city pedestrianize the downtown core?',
      [
        { name: 'alpha', persona: 'Alpha', provider: 'codex' },
        { name: 'beta', persona: 'Beta', provider: 'codex' },
      ],
      {},
      ctx,
    );

    expect(session.state.status).toBe('ended');
    expect(session.state.end_reason_content).toBe('No eligible agents remaining. Ending discussion.');
    expect(session.state.current_bids).toEqual({ alpha: 0, beta: 0 });
    expect(session.state.pending_bidders).toEqual([]);
  });

  it('preserves healthy submitted bids during later-round expulsion', async () => {
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const session = manager.createSession('discuss-1', {
      ...createState('discuss-1'),
      status: 'bidding',
      step: 3,
      epoch: 2,
      cold_start: false,
      bid_release_step: 2,
      current_bids: { alpha: 88, beta: null },
      current_thoughts: { alpha: 'I need to answer the financing point.' },
      pending_bidders: ['beta'],
    });
    session.agentRuns.set('beta', { provider: 'codex', sessionId: 'resume-beta' });

    vi.spyOn(manager, 'runAgentTurn').mockRejectedValue(new Error('resume failed'));

    await collectBids(manager, 'discuss-1', ctx);

    expect(session.state.status).toBe('bidding');
    expect(session.state.bid_release_step).toBe(2);
    expect(session.state.current_bids).toEqual({ alpha: 88, beta: 0 });
    expect(session.state.current_thoughts).toEqual({
      alpha: 'I need to answer the financing point.',
      beta: '',
    });
    expect(session.state.agents.beta?.banned).toBe(true);
    expect(session.state.pending_bidders).toEqual([]);
  });

  it('does not auto-bid for manual observer participants', async () => {
    vi.useFakeTimers();
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const runAgentTurn = vi.spyOn(manager, 'runAgentTurn')
      .mockResolvedValueOnce({ content: '{"score": 61, "thought": "I should frame the tradeoff."}', nonResumable: false })
      .mockResolvedValueOnce({ content: '{"score": 37, "thought": "I have a narrower follow-up."}', nonResumable: false });

    const session = await manager.start(
      'discuss-1',
      'Should the city pedestrianize the downtown core?',
      [
        { name: 'alpha', persona: 'Alpha', provider: 'codex' },
        { name: 'beta', persona: 'Beta', provider: 'codex' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      { min_bid_delay_ms: 1000 },
      ctx,
    );

    expect(runAgentTurn).toHaveBeenCalledTimes(2);
    expect(session.state.current_bids.user).toBeNull();
    expect(session.agentRuns.has('user')).toBe(false);
    session.controller.abort();
  });
});
