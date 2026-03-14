import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '../../discuss/events.js';
import * as discussReaders from '../../client/readers.js';
import {
  createDiscussContextRegistry,
  get as getDiscussContext,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
} from '../discuss-context-registry.js';
import { runPlainTurn } from '../discuss-executor.js';
import { continueLoop } from '../discuss-loop.js';
import {
  abortDiscussSession,
  getWatchState,
  recoverPersistedSessions,
  startDiscussSession,
} from '../discuss-operations.js';
import { detachSession, getSession } from '../discuss-registry.js';
import {
  DEFAULT_TOPIC,
  attachPersistedSession,
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

describe('Discuss context registry', () => {
  it('isolates live sessions by project root', async () => {
    const serviceOne = createExecutionServiceStub();
    const serviceTwo = createExecutionServiceStub();
    const harnessOne = createDiscussHarness(serviceOne);
    const harnessTwo = createDiscussHarness(serviceTwo);
    const registry = createDiscussContextRegistry();
    const contextOne = getOrCreateDiscussContext(registry, harnessOne.projectRoot, serviceOne, harnessOne.store);
    const contextTwo = getOrCreateDiscussContext(registry, harnessTwo.projectRoot, serviceTwo, harnessTwo.store);

    const snapshotOne = await persistSession(harnessOne, { sessionId: 'shared', recover: false });
    const snapshotTwo = await persistSession(harnessTwo, { sessionId: 'shared', topic: 'topic two', recover: false });
    attachPersistedSession({ context: contextOne }, snapshotOne);
    attachPersistedSession({ context: contextTwo }, snapshotTwo);

    expect(getDiscussContext(registry, harnessOne.projectRoot)).toBe(contextOne);
    expect(getDiscussContext(registry, harnessTwo.projectRoot)).toBe(contextTwo);
    expect(getSession(contextOne, 'shared')?.snapshot.state.topic).toBe(DEFAULT_TOPIC);
    expect(getSession(contextTwo, 'shared')?.snapshot.state.topic).toBe('topic two');
    expect(hasRunningSessions(registry)).toBe(true);

    detachSession(contextOne, 'shared');
    expect(getSession(contextOne, 'shared')).toBeUndefined();
    expect(getSession(contextTwo, 'shared')).toBeDefined();

    harnessOne.cleanup();
    harnessTwo.cleanup();
  });
});

describe('Discuss executor and operations', () => {
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

    const result = await runPlainTurn(harness.context, {
      agentName: 'alpha',
      sessionId: 'discuss-1',
      provider: 'codex',
      model: 'gpt-5',
      prompt: 'Bid now',
      instruction: 'System turn contract',
      cwd: '/repo',
      callerCtx: harness.ctx,
      purpose: 'turn',
    });

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
    expect(getSession(harness.context, 'discuss-1')?.snapshot.runtime.agentRuns.alpha).toMatchObject({
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

    const result = await runPlainTurn(harness.context, {
      agentName: 'alpha',
      sessionId: 'discuss-1',
      provider: 'claude',
      model: 'sonnet',
      prompt: 'Speak now',
      instruction: 'Resume turn contract',
      cwd: '/repo',
      callerCtx: harness.ctx,
      purpose: 'turn',
    });

    expect(resume).toHaveBeenCalledWith('claude', {
      sessionId: 'exec-session-1',
      prompt: 'Resume turn contract\n\n---\n\nSpeak now',
      model: 'sonnet',
      pool: 'discuss',
      cwd: '/repo',
      bypassPermissions: true,
    }, harness.ctx);
    expect(result).toEqual({ content: 'speech result', nonResumable: true });
    expect(getSession(harness.context, 'discuss-1')?.snapshot.runtime.agentRuns.alpha).toMatchObject({
      executionSessionId: 'exec-session-1',
      currentJobId: undefined,
      currentAttempt: 1,
      lastAttemptOutcome: 'non_resumable',
    });

    harness.cleanup();
  });

  it('schedules the loop after start completes initial bid collection', async () => {
    vi.useFakeTimers();
    const start = vi.fn()
      .mockResolvedValueOnce({ status: 'running', job: 'job-1', session: 'exec-alpha' })
      .mockResolvedValueOnce({ status: 'running', job: 'job-2', session: 'exec-beta' });
    const waitStreamOnce = vi.fn()
      .mockResolvedValueOnce({ content: '{"score": 61, "thought": "alpha"}', nonResumable: false })
      .mockResolvedValueOnce({ content: '{"score": 37, "thought": "beta"}', nonResumable: false });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));

    const session = await startDiscussSession(
      harness.context,
      'discuss-1',
      DEFAULT_TOPIC,
      defaultAgents().map((agent) => ({ ...agent, provider: 'codex' })),
      {},
      harness.ctx,
    );

    expect(session.snapshot.state.current_bids).toEqual({ alpha: 61, beta: 37 });
    expect(session.snapshot.state.status).toBe('bidding');
    await vi.runAllTimersAsync();
    expect(getSession(harness.context, 'discuss-1')?.snapshot.state.status).not.toBe('bidding');

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

    await recoverPersistedSessions(harness.context, harness.ctx);
    const recoveryReadCount = readDiscussEventLogSpy.mock.calls.length;

    expect(recoveryReadCount).toBeGreaterThan(0);
    expect(getWatchState(harness.context, 'discuss-recovery')).toMatchObject({
      cursor: 2,
    });
    expect(getWatchState(harness.context, 'discuss-recovery', 1)).toMatchObject({
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

    const state1 = getWatchState(harness.context, 'discuss-copy');
    state1.events.push({ type: 'fake' } as never);
    const state2 = getWatchState(harness.context, 'discuss-copy');

    expect(state1.events).not.toBe(state2.events);
    expect(state2.events).not.toContainEqual({ type: 'fake' });

    harness.cleanup();
  });

  it('getWatchState falls back to disk for ended sessions after detach', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-ended',
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
          content: 'Final speech before end.',
          decrementQuota: true,
          recordLastSpeechStep: 1,
        }),
      ],
    });

    const stateBefore = getWatchState(harness.context, 'discuss-ended');
    expect(stateBefore.cursor).toBe(2);

    detachSession(harness.context, 'discuss-ended');
    expect(getSession(harness.context, 'discuss-ended')).toBeUndefined();

    const stateAfter = getWatchState(harness.context, 'discuss-ended');
    expect(stateAfter.status).toBe(stateBefore.status);
    expect(stateAfter.cursor).toBe(2);
    expect(stateAfter.events).toHaveLength(2);

    const stateWithCursor = getWatchState(harness.context, 'discuss-ended', 1);
    expect(stateWithCursor.events).toHaveLength(1);
    expect(stateWithCursor.cursor).toBe(2);

    harness.cleanup();
  });

  it('getWatchState returns session_not_found for non-existent sessions', () => {
    const harness = createDiscussHarness();
    expect(() => getWatchState(harness.context, 'non-existent')).toThrow('session_not_found');
    harness.cleanup();
  });

  it('sets abortEnded on the cached session before abort detaches it', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-abort',
      recover: true,
    });

    const sessionRef = getSession(harness.context, 'discuss-abort');

    expect(sessionRef).toBeDefined();

    await abortDiscussSession(harness.context, 'discuss-abort');

    expect(sessionRef?.abortEnded).toBe(true);

    harness.cleanup();
  });
});
