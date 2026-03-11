import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '../../discuss/events.js';
import * as discussReaders from '../../client/readers.js';
import { DiscussManagerRegistry } from '../discuss-manager.js';
import type { CallerContext } from '../service.js';
import {
  DEFAULT_TOPIC,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  defaultAgents,
  persistSession,
} from './discuss-test-helpers.js';

afterEach(() => {
  cleanupDiscussHarnesses();
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DiscussManagerRegistry', () => {
  it('isolates live sessions by project root', async () => {
    const serviceOne = createExecutionServiceStub();
    const serviceTwo = createExecutionServiceStub();
    const harnessOne = createDiscussHarness(serviceOne);
    const harnessTwo = createDiscussHarness(serviceTwo);
    const registry = new DiscussManagerRegistry();
    const managerOne = registry.getOrCreate(harnessOne.projectRoot, serviceOne);
    const managerTwo = registry.getOrCreate(harnessTwo.projectRoot, serviceTwo);

    await persistSession({ ...harnessOne, manager: managerOne }, { sessionId: 'shared', recover: true });
    await persistSession({ ...harnessTwo, manager: managerTwo }, { sessionId: 'shared', topic: 'topic two', recover: true });

    expect(registry.get(harnessOne.projectRoot)).toBe(managerOne);
    expect(registry.get(harnessTwo.projectRoot)).toBe(managerTwo);
    expect(managerOne.getSession('shared')?.snapshot.state.topic).toBe(DEFAULT_TOPIC);
    expect(managerTwo.getSession('shared')?.snapshot.state.topic).toBe('topic two');
    expect(registry.hasLiveSessions()).toBe(true);

    managerOne.detachSession('shared');
    expect(managerOne.getSession('shared')).toBeUndefined();
    expect(managerTwo.getSession('shared')).toBeDefined();

    harnessOne.cleanup();
    harnessTwo.cleanup();
  });
});

describe('DiscussManager.runAgentTurn', () => {
  it('starts a first turn, binds the execution session, and records the finished attempt', async () => {
    const start = vi.fn().mockResolvedValue({
      status: 'running',
      job: 'job-1',
      session: 'exec-session-1',
    });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'bid result',
      nonResumable: false,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    await persistSession(harness, { sessionId: 'discuss-1', recover: true });

    const result = await (harness.manager as unknown as {
      runPlainTurn(
        agentName: string,
        sessionId: string,
        provider: string,
        model: string | undefined,
        prompt: string,
        instruction: string,
        cwd: string,
        ctx: CallerContext,
        purpose: string,
        timeoutMs?: number,
      ): Promise<{ content: string; nonResumable: boolean }>
    }).runPlainTurn(
      'alpha',
      'discuss-1',
      'codex',
      'gpt-5',
      'Bid now',
      'System turn contract',
      '/repo',
      harness.ctx,
      'turn',
    );

    expect(start).toHaveBeenCalledWith('codex', {
      prompt: 'Bid now',
      model: 'gpt-5',
      pool: 'discuss',
      cwd: '/repo',
      bypassPermissions: true,
      instruction: {
        channel: 'system',
        content: 'System turn contract',
      },
    }, harness.ctx);
    expect(waitStreamOnce).toHaveBeenCalledWith('job-1', undefined);
    expect(result).toEqual({ content: 'bid result', nonResumable: false });
    expect(harness.manager.getSession('discuss-1')?.snapshot.runtime.agentRuns.alpha).toMatchObject({
      provider: 'codex',
      executionSessionId: 'exec-session-1',
      currentJobId: undefined,
      currentAttempt: 1,
      lastAttemptOutcome: 'completed',
    });

    harness.cleanup();
  });

  it('resumes existing runs with the persisted execution session id', async () => {
    const resume = vi.fn().mockResolvedValue({
      status: 'running',
      job: 'job-2',
      session: 'exec-session-1',
    });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: 'speech result',
      nonResumable: true,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ resume, waitStreamOnce }));
    await persistSession(harness, {
      sessionId: 'discuss-1',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'agent.run.bound',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', executionSessionId: 'exec-session-1' },
        ),
      ],
    });

    const result = await (harness.manager as unknown as {
      runPlainTurn(
        agentName: string,
        sessionId: string,
        provider: string,
        model: string | undefined,
        prompt: string,
        instruction: string,
        cwd: string,
        ctx: CallerContext,
        purpose: string,
        timeoutMs?: number,
      ): Promise<{ content: string; nonResumable: boolean }>
    }).runPlainTurn(
      'alpha',
      'discuss-1',
      'claude',
      'sonnet',
      'Speak now',
      'Resume turn contract',
      '/repo',
      harness.ctx,
      'turn',
    );

    expect(resume).toHaveBeenCalledWith('claude', {
      sessionId: 'exec-session-1',
      prompt: 'Resume turn contract\n\n---\n\nSpeak now',
      model: 'sonnet',
      pool: 'discuss',
      cwd: '/repo',
      bypassPermissions: true,
    }, harness.ctx);
    expect(result).toEqual({ content: 'speech result', nonResumable: true });
    expect(harness.manager.getSession('discuss-1')?.snapshot.runtime.agentRuns.alpha).toMatchObject({
      executionSessionId: 'exec-session-1',
      currentJobId: undefined,
      currentAttempt: 1,
      lastAttemptOutcome: 'non_resumable',
    });

    harness.cleanup();
  });

  it('schedules the loop after start completes initial bid collection', async () => {
    vi.useFakeTimers();
    const harness = createDiscussHarness();
    const managerInternals = harness.manager as unknown as {
      collectBids(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
      continueLoop(targetSessionId: string, targetCtx: CallerContext): Promise<void>;
    };
    const collectBidsSpy = vi.spyOn(managerInternals, 'collectBids').mockResolvedValue();
    const continueLoopSpy = vi.spyOn(managerInternals, 'continueLoop').mockResolvedValue();

    await harness.manager.start(
      'discuss-1',
      DEFAULT_TOPIC,
      defaultAgents().map((agent) => ({ ...agent, provider: 'codex' })),
      {},
      harness.ctx,
    );

    expect(collectBidsSpy).toHaveBeenCalledWith('discuss-1', harness.ctx);
    expect(continueLoopSpy).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(continueLoopSpy).toHaveBeenCalledWith('discuss-1', harness.ctx);

    harness.cleanup();
  });

  it('recovery hydrates watch history once and repeated polls stay in memory', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-recovery',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.round.closed', '2026-03-10T00:01:00.000Z', {
          allBids: { alpha: 88, beta: 42 },
          effectiveBids: { alpha: 88, beta: 42 },
          thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
          outcome: { winner: 'alpha', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'session.ended', '2026-03-10T00:01:01.000Z', {
          endReason: 'all_blocked',
          endReasonContent: 'All blocked.',
        }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 3, 'session.synthesized', '2026-03-10T00:01:02.000Z', {
          synthesis: 'The discussion ended without consensus.',
        }),
      ],
    });
    const readDiscussEventLogSpy = vi.spyOn(discussReaders, 'readDiscussEventLog');

    await harness.manager.recoverPersistedSessions(harness.ctx);
    const recoveryReadCount = readDiscussEventLogSpy.mock.calls.length;

    expect(recoveryReadCount).toBeGreaterThan(0);
    expect(harness.manager.getWatchState('discuss-recovery')).toMatchObject({
      cursor: 2,
    });
    expect(harness.manager.getWatchState('discuss-recovery', 1)).toMatchObject({
      cursor: 2,
    });
    expect(readDiscussEventLogSpy).toHaveBeenCalledTimes(recoveryReadCount);

    harness.cleanup();
  });

  it('getWatchState returns a fresh events array on each call', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-copy',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 1, 'bid.round.closed', '2026-03-10T00:01:00.000Z', {
          allBids: { alpha: 88, beta: 42 },
          effectiveBids: { alpha: 88, beta: 42 },
          thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
          outcome: { winner: 'alpha', speaker_type: 'quota' as const },
          stateMutations: { cold_start: false },
        }),
        makeEvent(snapshot.sessionId, harness.projectRoot, snapshot.state.topic, snapshot.lastAppliedSeq + 2, 'speech.recorded', '2026-03-10T00:01:01.000Z', {
          agent: 'alpha',
          content: 'Open the street to buses and bikes first.',
          decrementQuota: true,
          recordLastSpeechStep: 1,
        }),
      ],
    });

    const state1 = harness.manager.getWatchState('discuss-copy');
    state1.events.push({ type: 'fake' } as never);
    const state2 = harness.manager.getWatchState('discuss-copy');

    expect(state1.events).not.toBe(state2.events);
    expect(state2.events).not.toContainEqual({ type: 'fake' });

    harness.cleanup();
  });

  it('sets abortEnded on the cached session before abort detaches it', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-abort',
      recover: true,
    });

    const sessions = (harness.manager as unknown as {
      sessions: Map<string, { abortEnded: boolean }>;
    }).sessions;
    const sessionRef = sessions.get('discuss-abort');

    expect(sessionRef).toBeDefined();

    await harness.manager.abortSession('discuss-abort');

    expect(sessionRef?.abortEnded).toBe(true);

    harness.cleanup();
  });
});
