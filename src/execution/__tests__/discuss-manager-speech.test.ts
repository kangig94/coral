import { afterEach, describe, expect, it, vi } from 'vitest';

import { initSession } from '../../discuss/state-machine.js';
import type { WaitStreamEvent } from '../../types.js';
import * as discussPrompts from '../discuss-prompts.js';
import { DiscussManager } from '../discuss-manager.js';
import type { CallerContext, ExecutionService } from '../service.js';

const ctx: CallerContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
};

function createAsyncEventStream(events: WaitStreamEvent[]): AsyncGenerator<WaitStreamEvent> {
  return (async function* stream() {
    for (const event of events) {
      yield event;
    }
  })();
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

describe('DiscussManager speech collection', () => {
  it('records a successful speech and emits a speech_done watch event', async () => {
    const manager = new DiscussManager('/tmp/project', createExecServiceStub());
    const session = manager.createSession('discuss-1', {
      ...createState('discuss-1'),
      status: 'speaking',
      current_speaker: 'alpha',
      speaker_type: 'quota',
    });
    session.agentRuns.set('alpha', { provider: 'codex', sessionId: 'exec-alpha' });

    vi.spyOn(manager, 'runAgentTurn').mockResolvedValue({
      content: 'Pedestrianization should start with the transit-heavy core and freight exemptions.',
      nonResumable: false,
    });

    await collectSpeech(manager, 'discuss-1', 'alpha', ctx);

    expect(session.state.status).toBe('bidding');
    expect(session.state.current_speaker).toBeNull();
    expect(session.state.transcript.at(-1)).toMatchObject({
      type: 'speech',
      agent: 'alpha',
      content: 'Pedestrianization should start with the transit-heavy core and freight exemptions.',
    });
    expect(session.watchLog.at(-1)).toEqual({
      type: 'speech_done',
      data: {
        speaker: 'alpha',
        content: 'Pedestrianization should start with the transit-heavy core and freight exemptions.',
      },
      ts: expect.any(Number),
    });
  });

  it('applies speech timeout when waitStreamOnce exceeds the stale timeout', async () => {
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

    expect(start).toHaveBeenCalledTimes(1);
    expect(waitStreamOnce).toHaveBeenCalledWith('job-1', 300000);
    expect(session.state.status).toBe('bidding');
    expect(session.state.transcript.at(-1)).toMatchObject({
      type: 'speech',
      agent: 'alpha',
    });
    const timeoutEntry = session.state.transcript.at(-1);
    expect(timeoutEntry?.type).toBe('speech');
    if (timeoutEntry?.type === 'speech') {
      expect(timeoutEntry.content).toContain('(alpha) timed out without delivering a speech.');
    }
  });

  it('passes prior speech only to listeners during the next bid collection', async () => {
    const manager = new DiscussManager('/tmp/project', createExecServiceStub());
    const session = manager.createSession('discuss-1', {
      ...createState('discuss-1'),
      status: 'bidding',
      step: 2,
      last_speech_step: 1,
      current_bids: { alpha: null, beta: null },
      pending_bidders: ['alpha', 'beta'],
      transcript: [
        {
          type: 'speech',
          step: 1,
          epoch: 1,
          ts: '2026-03-10T00:01:00.000Z',
          agent: 'alpha',
          display_name: 'Alpha',
          content: 'We need to talk about freight access before setting a ban.',
        },
      ],
    });
    session.agentRuns.set('alpha', { provider: 'codex' });
    session.agentRuns.set('beta', { provider: 'codex' });

    const realBuildBidPrompt = discussPrompts.buildBidPrompt;
    const buildBidPromptSpy = vi.spyOn(discussPrompts, 'buildBidPrompt').mockImplementation((promptCtx) =>
      realBuildBidPrompt(promptCtx),
    );
    vi.spyOn(manager, 'runAgentTurn')
      .mockResolvedValueOnce({ content: '{"score": 44, "thought": "Need to answer the follow-up."}', nonResumable: false })
      .mockResolvedValueOnce({ content: '{"score": 58, "thought": "I should build on that point."}', nonResumable: false });

    await collectBids(manager, 'discuss-1', ctx);

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
});
