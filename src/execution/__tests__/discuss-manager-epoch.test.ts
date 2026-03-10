import { afterEach, describe, expect, it, vi } from 'vitest';

import { initSession } from '../../discuss/state-machine.js';
import * as stateMachine from '../../discuss/state-machine.js';
import { DiscussManager } from '../discuss-manager.js';
import type { CallerContext, ExecutionService } from '../service.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
};

function createServiceStub(): ExecutionService {
  return Object.create(null) as ExecutionService;
}

function createEpochState(sessionId: string) {
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
    status: 'bidding' as const,
    step: 2,
    epoch: 2,
    epoch_summary_written: null,
    cold_start: true,
    pending_bidders: ['alpha', 'beta'],
    transcript: [
      {
        type: 'speech' as const,
        step: 1,
        epoch: 1,
        ts: '2026-03-10T00:01:00.000Z',
        agent: 'alpha',
        display_name: 'Alpha',
        content: 'We need to phase the rollout carefully.',
      },
    ],
  };
}

function handleEpochTransition(
  manager: DiscussManager,
  sessionId: string,
  currentCtx: CallerContext,
): Promise<void> {
  return (manager as unknown as {
    handleEpochTransition(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
  }).handleEpochTransition(sessionId, currentCtx);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiscussManager epoch evaluation', () => {
  it('applies the epoch summary and continues when convergence stays below the threshold', async () => {
    const applyEpochSummarySpy = vi.spyOn(stateMachine, 'applyEpochSummary');
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const session = manager.createSession('discuss-1', createEpochState('discuss-1'));

    vi.spyOn(manager, 'runAgentTurn').mockResolvedValue({
      content: JSON.stringify({
        convergence: 4,
        summary: 'The panel is still split on freight exemptions.',
        must_answer: [{ to: 'alpha', question: 'What freight exemption would you accept?' }],
      }),
      nonResumable: false,
    });

    await handleEpochTransition(manager, 'discuss-1', ctx);

    expect(applyEpochSummarySpy).toHaveBeenCalledOnce();
    expect(session.state.status).toBe('bidding');
    expect(session.state.epoch_summary_written).toBe(2);
    expect(session.mustAnswerQueue).toEqual([
      { to: 'alpha', question: 'What freight exemption would you accept?' },
    ]);
    expect(session.watchLog[0]).toMatchObject({
      type: 'epoch_transition',
      data: { epoch: 2 },
    });
  });

  it('ends the discussion when the evaluator reports convergence with no follow-ups', async () => {
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const session = manager.createSession('discuss-1', createEpochState('discuss-1'));

    vi.spyOn(manager, 'runAgentTurn')
      .mockResolvedValueOnce({
        content: JSON.stringify({
          convergence: 8,
          summary: 'The panel now agrees on a phased rollout.',
          must_answer: [],
        }),
        nonResumable: false,
      })
      .mockResolvedValueOnce({
        content: 'The discussion converged on a phased downtown pedestrianization plan.',
        nonResumable: false,
      });

    await handleEpochTransition(manager, 'discuss-1', ctx);

    expect(session.state.status).toBe('ended');
    expect(session.state.end_reason_content).toBe('Discussion converged.');
    expect(session.watchLog.map((event) => event.type)).toEqual([
      'epoch_transition',
      'session_ended',
    ]);
  });

  it('runs follow-up turns before ending when convergence depends on specific answers', async () => {
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const session = manager.createSession('discuss-1', createEpochState('discuss-1'));

    const runAgentTurn = vi.spyOn(manager, 'runAgentTurn')
      .mockResolvedValueOnce({
        content: JSON.stringify({
          convergence: 9,
          summary: 'The panel is nearly aligned.',
          must_answer: [
            { to: 'alpha', question: 'What freight exemption would you accept?' },
            { to: 'beta', question: 'How would you phase delivery access?' },
          ],
        }),
        nonResumable: false,
      })
      .mockResolvedValueOnce({
        content: 'Allow timed morning freight windows.',
        nonResumable: false,
      })
      .mockResolvedValueOnce({
        content: 'Start with the transit core and expand quarterly.',
        nonResumable: false,
      })
      .mockResolvedValueOnce({
        content: 'The discussion converged after clarifying freight access and rollout timing.',
        nonResumable: false,
      });

    await handleEpochTransition(manager, 'discuss-1', ctx);

    expect(runAgentTurn).toHaveBeenCalledTimes(4);
    expect(session.state.status).toBe('ended');
    expect(session.state.end_reason_content).toBe('Discussion converged after follow-ups.');
    expect(session.followUpEntries).toHaveLength(2);
    expect(session.state.transcript.filter((entry) => entry.type === 'follow_up')).toHaveLength(2);
  });

  it('treats evaluator JSON parse failures as non-converged and continues the discussion', async () => {
    const applyEpochSummarySpy = vi.spyOn(stateMachine, 'applyEpochSummary');
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const session = manager.createSession('discuss-1', createEpochState('discuss-1'));

    vi.spyOn(manager, 'runAgentTurn').mockResolvedValue({
      content: 'not valid json',
      nonResumable: false,
    });

    await handleEpochTransition(manager, 'discuss-1', ctx);

    expect(applyEpochSummarySpy).toHaveBeenCalledOnce();
    expect(session.state.status).toBe('bidding');
    expect(session.mustAnswerQueue).toEqual([]);
    expect(session.state.epoch_summary_written).toBe(2);
  });
});
