import { afterEach, describe, expect, it, vi } from 'vitest';

import { initSession } from '../../discuss/state-machine.js';
import * as stateMachine from '../../discuss/state-machine.js';
import type { WaitStreamEvent } from '../../types.js';
import { DiscussManager } from '../discuss-manager.js';
import type { CallerContext, ExecutionService } from '../service.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
};

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

function createAsyncEventStream(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  return (async function* stream() {
    for (const event of events) {
      yield event;
    }
  })();
}

function createExecServiceStub(overrides?: {
  start?: ReturnType<typeof vi.fn>;
  resume?: ReturnType<typeof vi.fn>;
  waitStream?: ReturnType<typeof vi.fn>;
  waitStreamOnce?: ReturnType<typeof vi.fn>;
}): ExecutionService {
  return {
    start: overrides?.start ?? vi.fn(),
    resume: overrides?.resume ?? vi.fn(),
    waitStream: overrides?.waitStream ?? vi.fn(() => createAsyncEventStream([])),
    waitStreamOnce: overrides?.waitStreamOnce ?? vi.fn(),
  } as unknown as ExecutionService;
}

function collectBids(manager: DiscussManager, sessionId: string, currentCtx: CallerContext): Promise<void> {
  return (manager as unknown as {
    collectBids(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
  }).collectBids(sessionId, currentCtx);
}

function collectSpeech(
  manager: DiscussManager,
  sessionId: string,
  winnerName: string,
  currentCtx: CallerContext,
): Promise<void> {
  return (manager as unknown as {
    collectSpeech(targetSessionId: string, targetWinnerName: string, targetCtx: CallerContext): Promise<void>;
  }).collectSpeech(sessionId, winnerName, currentCtx);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiscussManager fault handling', () => {
  it('expels a non-resumable bidder without wiping healthy later-round bids', async () => {
    const manager = new DiscussManager('/tmp/project', createExecServiceStub());
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

    vi.spyOn(manager, 'runAgentTurn').mockResolvedValue({
      content: '',
      nonResumable: true,
    });

    await collectBids(manager, 'discuss-1', ctx);

    expect(session.state.current_bids).toEqual({ alpha: 88, beta: 0 });
    expect(session.state.current_thoughts).toEqual({
      alpha: 'I need to answer the financing point.',
      beta: '',
    });
    expect(session.state.agents.beta?.banned).toBe(true);
    expect(session.state.pending_bidders).toEqual([]);
  });

  it('treats a non-resumable speech turn as a speech timeout', async () => {
    const timeoutSpy = vi.spyOn(stateMachine, 'applySpeechTimeout');
    const manager = new DiscussManager('/tmp/project', createExecServiceStub());
    const session = manager.createSession('discuss-1', {
      ...createState('discuss-1'),
      status: 'speaking',
      current_speaker: 'alpha',
      speaker_type: 'quota',
    });
    session.agentRuns.set('alpha', { provider: 'codex', sessionId: 'exec-alpha' });

    vi.spyOn(manager, 'runAgentTurn').mockResolvedValue({
      content: 'ignored',
      nonResumable: true,
    });

    await collectSpeech(manager, 'discuss-1', 'alpha', ctx);

    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(session.state.status).toBe('bidding');
    const timeoutEntry = session.state.transcript.at(-1);
    expect(timeoutEntry?.type).toBe('speech');
    if (timeoutEntry?.type === 'speech') {
      expect(timeoutEntry.content).toContain('(alpha) timed out without delivering a speech.');
    }
  });

  it('expels a timed-out bidder without wiping healthy later-round bids', async () => {
    const manager = new DiscussManager('/tmp/project', createExecServiceStub());
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

    vi.spyOn(manager, 'runAgentTurn').mockRejectedValue(new Error('Job timed out waiting for terminal result'));

    await collectBids(manager, 'discuss-1', ctx);

    expect(session.state.current_bids).toEqual({ alpha: 88, beta: 0 });
    expect(session.state.current_thoughts).toEqual({
      alpha: 'I need to answer the financing point.',
      beta: '',
    });
    expect(session.state.agents.beta?.banned).toBe(true);
    expect(session.state.pending_bidders).toEqual([]);
  });

  it('treats a speech waitStreamOnce timeout as a speech timeout', async () => {
    const timeoutSpy = vi.spyOn(stateMachine, 'applySpeechTimeout');
    const start = vi.fn().mockResolvedValue({
      status: 'running',
      job: 'job-1',
      session: 'exec-alpha',
    });
    const waitStreamOnce = vi.fn().mockRejectedValue(new Error('Job timed out waiting for terminal result'));
    const manager = new DiscussManager(
      '/tmp/project',
      createExecServiceStub({ start, waitStreamOnce }),
    );
    const session = manager.createSession('discuss-1', {
      ...createState('discuss-1'),
      status: 'speaking',
      current_speaker: 'alpha',
      speaker_type: 'quota',
    });
    session.agentRuns.set('alpha', { provider: 'codex' });

    await collectSpeech(manager, 'discuss-1', 'alpha', ctx);

    expect(waitStreamOnce).toHaveBeenCalledWith('job-1', 300000);
    expect(timeoutSpy).toHaveBeenCalledOnce();
    expect(session.state.status).toBe('bidding');
  });
});
