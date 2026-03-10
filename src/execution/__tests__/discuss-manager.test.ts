import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WaitStreamEvent } from '../../types.js';

import { initSession } from '../../discuss/state-machine.js';
import { DiscussManager, DiscussManagerRegistry } from '../discuss-manager.js';
import type { CallerContext, ExecutionService } from '../service.js';

function createServiceStub(): ExecutionService {
  return Object.create(null) as ExecutionService;
}

function createAsyncEventStream(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  return (async function* stream() {
    for (const event of events) {
      yield event;
    }
  })();
}

function createState(sessionId: string, topic: string) {
  return {
    ...initSession({
      topic,
      agents: [
        { name: 'alpha', persona: 'Alpha', participation: 'required' },
        { name: 'beta', persona: 'Beta', participation: 'required' },
      ],
      min_bid_delay_ms: 0,
    }, '2026-03-10T00:00:00.000Z'),
    session_id: sessionId,
  };
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

function continueLoop(manager: DiscussManager, sessionId: string, currentCtx: CallerContext): Promise<void> {
  return (manager as unknown as {
    continueLoop(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
  }).continueLoop(sessionId, currentCtx);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ctx: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
};

describe('DiscussManagerRegistry', () => {
  it('isolates sessions by project root and tracks live session state', () => {
    const registry = new DiscussManagerRegistry();
    const rootOne = '/tmp/project-one';
    const rootTwo = '/tmp/project-two';
    const managerOne = registry.getOrCreate(rootOne, createServiceStub());
    const managerTwo = registry.getOrCreate(rootTwo, createServiceStub());

    const sessionId = 'session-shared';
    const sessionOne = managerOne.createSession(sessionId, createState(sessionId, 'topic one'));
    const sessionTwo = managerTwo.createSession(sessionId, createState(sessionId, 'topic two'));

    expect(registry.get(rootOne)).toBe(managerOne);
    expect(registry.get(rootTwo)).toBe(managerTwo);
    expect(managerOne.getSession(sessionId)).toBe(sessionOne);
    expect(managerTwo.getSession(sessionId)).toBe(sessionTwo);
    expect(managerOne.getSession(sessionId)?.state.topic).toBe('topic one');
    expect(managerTwo.getSession(sessionId)?.state.topic).toBe('topic two');
    expect(registry.hasLiveSessions()).toBe(true);

    managerOne.removeSession(sessionId);
    expect(managerOne.getSession(sessionId)).toBeUndefined();
    expect(managerTwo.getSession(sessionId)).toBe(sessionTwo);
    expect(registry.hasLiveSessions()).toBe(true);

    managerTwo.removeSession(sessionId);
    expect(managerTwo.getSession(sessionId)).toBeUndefined();
    expect(registry.hasLiveSessions()).toBe(false);
  });
});

describe('DiscussManager.runAgentTurn', () => {
  it('starts a first turn in the discuss pool and records the execution session id after terminal', async () => {
    const start = vi.fn().mockResolvedValue({
      status: 'running',
      job: 'job-1',
      session: 'exec-session-1',
    });
    const waitStream = vi.fn(() => createAsyncEventStream([
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'exec-session-1',
        remainingJobIds: [],
        resultPath: '/tmp/job-1/result.md',
        result: { content: 'bid result' },
      },
    ]));
    const manager = new DiscussManagerRegistry().getOrCreate(
      '/tmp/project',
      createExecServiceStub({ start, waitStream }),
    );
    const session = manager.createSession('discuss-1', createState('discuss-1', 'topic one'));

    const result = await manager.runAgentTurn(
      'alpha',
      'discuss-1',
      'codex',
      'o4-mini',
      'Bid now',
      'System turn contract',
      '/repo',
      ctx,
    );

    expect(start).toHaveBeenCalledWith('codex', {
      prompt: 'Bid now',
      model: 'o4-mini',
      pool: 'discuss',
      cwd: '/repo',
      bypassPermissions: true,
      instruction: {
        channel: 'system',
        content: 'System turn contract',
      },
    }, ctx);
    expect(waitStream).toHaveBeenCalledWith({ jobIds: ['job-1'] });
    expect(result).toEqual({ content: 'bid result', nonResumable: false });
    expect(session.agentRuns.get('alpha')).toEqual({
      provider: 'codex',
      model: 'o4-mini',
      sessionId: 'exec-session-1',
      currentJobId: undefined,
    });
  });

  it('resumes existing runs by embedding the contract into the prompt and waiting through queued events', async () => {
    const resume = vi.fn().mockResolvedValue({
      status: 'queued',
      job: 'job-2',
      session: 'exec-session-1',
    });
    const waitStream = vi.fn(() => createAsyncEventStream([
      {
        type: 'queued',
        jobId: 'job-2',
        sessionId: 'exec-session-1',
        queuePosition: 1,
        runningJobIds: ['other-job'],
      },
      {
        type: 'terminal',
        completedJobId: 'job-2',
        sessionId: 'exec-session-1',
        remainingJobIds: [],
        resultPath: '/tmp/job-2/result.md',
        result: {
          content: 'speech result',
          nonResumable: true,
        },
      },
    ]));
    const manager = new DiscussManagerRegistry().getOrCreate(
      '/tmp/project',
      createExecServiceStub({ resume, waitStream }),
    );
    const session = manager.createSession('discuss-1', createState('discuss-1', 'topic one'));
    session.agentRuns.set('alpha', {
      provider: 'claude',
      model: 'sonnet',
      sessionId: 'exec-session-1',
    });

    const result = await manager.runAgentTurn(
      'alpha',
      'discuss-1',
      'claude',
      'sonnet',
      'Speak now',
      'Resume turn contract',
      '/repo',
      ctx,
    );

    expect(resume).toHaveBeenCalledWith('claude', {
      sessionId: 'exec-session-1',
      prompt: 'Resume turn contract\n\n---\n\nSpeak now',
      model: 'sonnet',
      pool: 'discuss',
      cwd: '/repo',
      bypassPermissions: true,
    }, ctx);
    expect(result).toEqual({ content: 'speech result', nonResumable: true });
    expect(session.agentRuns.get('alpha')).toEqual({
      provider: 'claude',
      model: 'sonnet',
      sessionId: 'exec-session-1',
      currentJobId: undefined,
    });
  });

  it('throws when the execution service rejects the launch', async () => {
    const start = vi.fn().mockResolvedValue({
      status: 'rejected',
      phase: 'preflight',
      code: 'busy',
      message: 'Runner busy',
    });
    const manager = new DiscussManagerRegistry().getOrCreate(
      '/tmp/project',
      createExecServiceStub({ start }),
    );
    const session = manager.createSession('discuss-1', createState('discuss-1', 'topic one'));
    session.agentRuns.set('alpha', { provider: 'codex' });

    await expect(manager.runAgentTurn(
      'alpha',
      'discuss-1',
      'codex',
      undefined,
      'Bid now',
      'System turn contract',
      '/repo',
      ctx,
    )).rejects.toThrow('Runner busy');

    expect(session.agentRuns.get('alpha')).toEqual({
      provider: 'codex',
      model: undefined,
    });
  });
});

describe('DiscussManager loop orchestration', () => {
  it('schedules continueLoop after the initial bid collection', async () => {
    vi.useFakeTimers();
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const managerInternals = manager as unknown as {
      collectBids(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
      continueLoop(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
    };
    const collectBidsSpy = vi.spyOn(managerInternals, 'collectBids').mockResolvedValue();
    const continueLoopSpy = vi.spyOn(managerInternals, 'continueLoop').mockResolvedValue();

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

    expect(collectBidsSpy).toHaveBeenCalledTimes(1);
    expect(continueLoopSpy).not.toHaveBeenCalled();

    await vi.runOnlyPendingTimersAsync();

    expect(continueLoopSpy).toHaveBeenCalledWith('discuss-1', ctx);
    session.controller.abort();
  });

  it('resolves bids, collects speech, and ends the session inside continueLoop', async () => {
    const manager = new DiscussManager('/tmp/project', createExecServiceStub());
    const session = manager.createSession('discuss-1', {
      ...createState('discuss-1', 'topic one'),
      status: 'bidding',
      cold_start: false,
      current_bids: { alpha: 61, beta: 37 },
      current_thoughts: {
        alpha: 'I should frame the tradeoff.',
        beta: 'I have a narrower follow-up.',
      },
      pending_bidders: [],
    });
    session.agentRuns.set('alpha', { provider: 'codex', sessionId: 'exec-alpha' });
    session.agentRuns.set('beta', { provider: 'codex', sessionId: 'exec-beta' });

    vi.spyOn(manager, 'runAgentTurn')
      .mockResolvedValueOnce({ content: 'Pedestrianization should start with the transit-heavy core.', nonResumable: false })
      .mockResolvedValueOnce({ content: '{"score": 0, "thought": "I do not need another turn."}', nonResumable: false })
      .mockResolvedValueOnce({ content: '{"score": 0, "thought": "I am done for now."}', nonResumable: false });

    await continueLoop(manager, 'discuss-1', ctx);

    expect(session.state.status).toBe('ended');
    expect(session.state.end_reason_content).toBe('All participants bid below the threshold. Ending discussion.');
    expect(session.watchLog.map((event) => event.type)).toEqual([
      'bid_resolved',
      'speech_done',
      'session_ended',
    ]);
    expect(session.watchLog[0]).toMatchObject({
      type: 'bid_resolved',
      data: { winner: 'alpha', speaker_type: 'quota' },
    });
    expect(session.watchLog[2]).toMatchObject({
      type: 'session_ended',
      data: { reason: 'all_below_threshold' },
    });
  });

  it('emits an epoch_transition event when resolveWinner advances the epoch', async () => {
    const manager = new DiscussManager('/tmp/project', createExecServiceStub());
    const session = manager.createSession('discuss-1', {
      ...createState('discuss-1', 'topic one'),
      status: 'bidding',
      cold_start: false,
      current_bids: { alpha: 45, beta: 41 },
      current_thoughts: {
        alpha: 'I have already used my quota.',
        beta: 'Same here.',
      },
      pending_bidders: [],
      agents: {
        alpha: { ...createState('discuss-1', 'topic one').agents.alpha, quota_remaining: 0, fallback_used: true },
        beta: { ...createState('discuss-1', 'topic one').agents.beta, quota_remaining: 0, fallback_used: true },
      },
    });
    const managerInternals = manager as unknown as {
      collectBids(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
    };
    vi.spyOn(managerInternals, 'collectBids').mockImplementation(async (targetSessionId: string) => {
      const currentSession = manager.getSession(targetSessionId);
      currentSession?.controller.abort();
    });

    await continueLoop(manager, 'discuss-1', ctx);

    expect(session.state.epoch).toBe(2);
    expect(session.state.status).toBe('bidding');
    expect(session.watchLog).toHaveLength(1);
    expect(session.watchLog[0]).toMatchObject({
      type: 'epoch_transition',
      data: { epoch: 2 },
    });
  });
});
