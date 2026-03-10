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

function createEndedState(sessionId: string) {
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
    status: 'ended' as const,
    transcript: [
      {
        type: 'speech' as const,
        step: 1,
        epoch: 1,
        ts: '2026-03-10T00:01:00.000Z',
        agent: 'alpha',
        display_name: 'Alpha',
        content: 'Start with the transit-heavy core.',
      },
    ],
  };
}

function handleSynthesis(
  manager: DiscussManager,
  sessionId: string,
  currentCtx: CallerContext,
): Promise<void> {
  return (manager as unknown as {
    handleSynthesis(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
  }).handleSynthesis(sessionId, currentCtx);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DiscussManager synthesis', () => {
  it('records a single synthesis entry from the synthesis launch result', async () => {
    const applySynthesisSpy = vi.spyOn(stateMachine, 'applySynthesis');
    const manager = new DiscussManager('/tmp/project', createServiceStub());
    const session = manager.createSession('discuss-1', createEndedState('discuss-1'));

    vi.spyOn(manager, 'runAgentTurn').mockResolvedValue({
      content: 'The panel supported a phased pedestrianization plan centered on transit access.',
      nonResumable: false,
    });

    await handleSynthesis(manager, 'discuss-1', ctx);

    expect(applySynthesisSpy).toHaveBeenCalledOnce();
    expect(session.state.transcript.at(-1)).toMatchObject({
      type: 'session_event',
      event: 'synthesis',
      detail: 'The panel supported a phased pedestrianization plan centered on transit access.',
    });
  });
});
