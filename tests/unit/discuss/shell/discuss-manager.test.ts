import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeEvent } from '#src/discuss/events.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import * as discussSpeechFlow from '#src/discuss/shell/flow/speech.js';
import {
  createDiscussContextRegistry,
  get as getDiscussContext,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
} from '#src/discuss/shell/live-registry.js';
import { PURPOSE_BID, PURPOSE_SPEECH, runPlainTurn } from '#src/discuss/shell/runtime-build.js';
import { abortDiscussSession, startDiscussSession } from '#src/discuss/shell/operations.js';
import { recoverPersistedSessionsFromStore } from '#src/discuss/shell/recovery.js';
import { detachSession, getSession, getWatchState } from '#src/discuss/shell/registry.js';
import {
  DEFAULT_TOPIC,
  advanceDiscussRuntime,
  attachPersistedSession,
  cleanupDiscussHarnesses,
  createDiscussHarness,
  createExecutionServiceStub,
  defaultAgents,
  discussContextOptions,
  persistSession,
  type DiscussHarness,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';

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
      authority: 'admin',
    }),
  );
}

function resumeRecoveredSessions(recovered: Awaited<ReturnType<typeof recoverSessions>>): void {
  for (const session of recovered) {
    discussLoop.resumeLoop(session.ctx, session.sessionId, session.invocationCtx);
  }
}

describe('Discuss context registry', () => {
  it('isolates live sessions by project root', async () => {
    const serviceOne = createExecutionServiceStub();
    const serviceTwo = createExecutionServiceStub();
    const harnessOne = createDiscussHarness(serviceOne);
    const harnessTwo = createDiscussHarness(serviceTwo);
    const registry = createDiscussContextRegistry();
    const contextOne = getOrCreateDiscussContext(
      registry,
      harnessOne.projectRoot,
      serviceOne,
      harnessOne.store,
      discussContextOptions(harnessOne),
    );
    const contextTwo = getOrCreateDiscussContext(
      registry,
      harnessTwo.projectRoot,
      serviceTwo,
      harnessTwo.store,
      discussContextOptions(harnessTwo),
    );

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

  it('treats ended sessions awaiting synthesis as running work', async () => {
    const harness = createDiscussHarness();
    const snapshot = await persistSession(harness, {
      sessionId: 'synthesis-window',
      recover: false,
      buildTail: (current) => [
        makeEvent(
          current.sessionId,
          harness.projectRoot,
          current.state.topic,
          current.lastAppliedSeq + 1,
          'session.ended',
          '2026-03-10T00:01:00.000Z',
          { endReason: 'all_blocked', endReasonContent: 'All blocked.' },
        ),
      ],
    });
    attachPersistedSession(harness, snapshot);

    expect(hasRunningSessions(harness.registry)).toBe(true);

    harness.cleanup();
  });

  it('does not let a watch subscriber exception break committed session events', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, { sessionId: 'subscriber-throws', recover: true });
    const session = getSession(harness.context, 'subscriber-throws');
    session?.watchSubscribers.add(() => {
      throw new Error('subscriber failed');
    });

    await expect(abortDiscussSession(harness.context, 'subscriber-throws')).resolves.toBeUndefined();
    expect(harness.store.load('subscriber-throws')?.state.status).toBe('ended');
    expect(getSession(harness.context, 'subscriber-throws')).toBeUndefined();

    harness.cleanup();
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
      continuity: null,
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
      invocationCtx: harness.ctx,
      purpose: PURPOSE_BID,
    });

    expect(start).toHaveBeenCalledWith(
      'codex',
      {
        prompt: 'Bid now',
        model: 'gpt-5',
        pool: 'discuss',
        cwd: '/repo',
        bypassPermissions: true,
        instruction: {
          channel: 'system',
          content: 'System turn contract',
        },
      },
      harness.ctx,
    );
    expect(waitStreamOnce).toHaveBeenCalledWith('job-1', undefined);
    expect(result).toEqual({ content: 'bid result', continuity: null });
    expect(getSession(harness.context, 'discuss-1')?.snapshot.runtime.agentRuns.alpha).toMatchObject({
      provider: 'codex',
      executionSessionId: 'exec-session-1',
      currentJobId: undefined,
      currentAttempt: 1,
      lastAttemptOutcome: 'completed',
    });

    harness.cleanup();
  });

  it('fails provider launch when start never returns a job id', async () => {
    const start = vi.fn(
      () =>
        new Promise<never>(() => {
          // Deliberately unresolved to exercise the discuss launch timeout.
        }),
    );
    const harness = createDiscussHarness(createExecutionServiceStub({ start }));
    await persistSession(harness, { sessionId: 'discuss-launch-timeout', recover: true });

    const turn = runPlainTurn(harness.context, {
      agentName: 'alpha',
      sessionId: 'discuss-launch-timeout',
      provider: 'codex',
      model: 'gpt-5',
      prompt: 'Bid now',
      instruction: 'System turn contract',
      cwd: '/repo',
      invocationCtx: harness.ctx,
      purpose: PURPOSE_BID,
    }).catch((error: unknown) => error);

    await advanceDiscussRuntime(harness, 30_000);
    const error = await turn;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('codex discuss launch timed out after 30000ms');
    const agentRun = harness.store.load('discuss-launch-timeout')?.runtime.agentRuns.alpha;
    expect(agentRun?.currentJobId).toBeUndefined();
    expect(agentRun?.currentAttempt).toBeUndefined();
    expect(agentRun?.lastAttemptOutcome).toBeUndefined();

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
      continuity: { conversationRef: null, resumable: false },
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
      invocationCtx: harness.ctx,
      purpose: PURPOSE_SPEECH,
    });

    expect(resume).toHaveBeenCalledWith(
      'claude',
      {
        sessionId: 'exec-session-1',
        prompt: 'Resume turn contract\n\n---\n\nSpeak now',
        model: 'sonnet',
        pool: 'discuss',
        cwd: '/repo',
        bypassPermissions: true,
      },
      harness.ctx,
    );
    expect(result).toEqual({
      content: 'speech result',
      continuity: { conversationRef: null, resumable: false },
    });
    expect(getSession(harness.context, 'discuss-1')?.snapshot.runtime.agentRuns.alpha).toMatchObject({
      executionSessionId: 'exec-session-1',
      currentJobId: undefined,
      currentAttempt: 1,
      lastAttemptOutcome: 'non_resumable',
    });

    harness.cleanup();
  });

  it('schedules the loop after start completes initial bid collection', async () => {
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
      defaultAgents().map((agent) => ({ ...agent, provider: 'codex' })),
      {},
      harness.ctx,
    );

    expect(session.snapshot.state.current_bids).toEqual({ alpha: 61, beta: 37 });
    expect(session.snapshot.state.status).toBe('bidding');
    await advanceDiscussRuntime(harness, 1);
    expect(getSession(harness.context, 'discuss-1')?.snapshot.state.status).not.toBe('bidding');

    harness.cleanup();
  });

  it('passes configured quota_per_epoch into session creation', async () => {
    const start = vi.fn().mockResolvedValue({ status: 'running', job: 'job-1', session: 'exec-alpha' });
    const waitStreamOnce = vi.fn().mockResolvedValue({
      content: '{"score": 61, "thought": "alpha"}',
      continuity: null,
    });
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    const config = { quota_per_epoch: 5 } as Parameters<typeof startDiscussSession>[4] & {
      quota_per_epoch: number;
    };
    vi.spyOn(discussLoop, 'resumeLoop').mockImplementation(() => undefined);

    const session = await startDiscussSession(
      harness.context,
      'discuss-quota',
      DEFAULT_TOPIC,
      [
        { name: 'alpha', persona: '# Alpha', participation: 'required' },
        { name: 'user', persona: '# User', participation: 'observer' },
      ],
      config,
      harness.ctx,
    );
    const created = harness.store.readSessionEvents('discuss-quota').find((event) => event.kind === 'session.created');

    expect(created).toMatchObject({
      payload: {
        config: {
          quotaPerEpoch: 5,
        },
      },
    });
    expect(session.snapshot.state.quota_per_epoch).toBe(5);
    expect(session.snapshot.state.agents.alpha.quota_remaining).toBe(5);
    expect(session.snapshot.state.agents.user.quota_remaining).toBe(5);

    harness.cleanup();
  });

  it('keeps fully synthesized ended history persisted-only while getWatchState falls back to disk', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-recovery',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'bid.round.closed',
          '2026-03-10T00:01:00.000Z',
          {
            allBids: { alpha: 88, beta: 42 },
            effectiveBids: { alpha: 88, beta: 42 },
            thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'session.ended',
          '2026-03-10T00:01:01.000Z',
          {
            endReason: 'all_blocked',
            endReasonContent: 'All blocked.',
          },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 3,
          'session.synthesized',
          '2026-03-10T00:01:02.000Z',
          {
            synthesis: 'The discussion ended without consensus.',
          },
        ),
      ],
    });
    const readSessionEventsSpy = vi.spyOn(harness.store, 'readSessionEvents');

    const recovered = await recoverSessions(harness);
    const recoveryReadCount = readSessionEventsSpy.mock.calls.length;

    expect(recovered).toHaveLength(0);
    expect(recoveryReadCount).toBeGreaterThan(0);
    expect(getSession(harness.context, 'discuss-recovery')).toBeUndefined();
    expect(getWatchState(harness.context, 'discuss-recovery')).toMatchObject({
      cursor: 2,
    });
    expect(getWatchState(harness.context, 'discuss-recovery', 1)).toMatchObject({
      cursor: 2,
    });
    expect(readSessionEventsSpy).toHaveBeenCalledTimes(recoveryReadCount + 2);

    harness.cleanup();
  });

  it('recovered observer_wait sessions restart the full bid delay from startup time', async () => {
    const harness = createDiscussHarness();
    vi.spyOn(discussSpeechFlow, 'collectSpeech').mockResolvedValue({ shouldResume: false });
    await persistSession(harness, {
      sessionId: 'discuss-observer-wait',
      recover: false,
      minBidDelayMs: 5_000,
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
          'bid.submitted',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', score: 88, thought: 'alpha bid' },
        ),
      ],
    });

    const recovered = await recoverSessions(harness);

    expect(recovered).toHaveLength(1);
    resumeRecoveredSessions(recovered);

    await advanceDiscussRuntime(harness, 4_999);
    expect(harness.store.load('discuss-observer-wait')?.state).toMatchObject({
      status: 'bidding',
      current_speaker: null,
    });

    await advanceDiscussRuntime(harness, 1);
    expect(harness.store.load('discuss-observer-wait')?.state).toMatchObject({
      status: 'speaking',
      current_speaker: 'alpha',
    });
  });

  it('recovered bidding sessions with no pending auto work still resume into round-close', async () => {
    const harness = createDiscussHarness();
    vi.spyOn(discussSpeechFlow, 'collectSpeech').mockResolvedValue({ shouldResume: false });
    await persistSession(harness, {
      sessionId: 'discuss-round-close',
      recover: false,
      agents: [{ name: 'alpha', persona: '# Alpha', participation: 'required' }],
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'bid.submitted',
          '2026-03-10T00:01:00.000Z',
          { agent: 'alpha', score: 88, thought: 'alpha bid' },
        ),
      ],
    });

    const recovered = await recoverSessions(harness);

    expect(recovered).toHaveLength(1);
    resumeRecoveredSessions(recovered);
    await advanceDiscussRuntime(harness, 1);

    expect(harness.store.load('discuss-round-close')?.state).toMatchObject({
      status: 'speaking',
      current_speaker: 'alpha',
    });
  });

  it('getWatchState returns a fresh events array on each call', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-copy',
      recover: true,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'bid.round.closed',
          '2026-03-10T00:01:00.000Z',
          {
            allBids: { alpha: 88, beta: 42 },
            effectiveBids: { alpha: 88, beta: 42 },
            thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'speech.recorded',
          '2026-03-10T00:01:01.000Z',
          {
            agent: 'alpha',
            content: 'Open the street to buses and bikes first.',
            decrementQuota: true,
            recordLastSpeechStep: 1,
          },
        ),
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
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'bid.round.closed',
          '2026-03-10T00:01:00.000Z',
          {
            allBids: { alpha: 88, beta: 42 },
            effectiveBids: { alpha: 88, beta: 42 },
            thoughts: { alpha: 'keep sealed', beta: 'also sealed' },
            outcome: { winner: 'alpha', speaker_type: 'quota' as const },
            stateMutations: { cold_start: false },
          },
        ),
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 2,
          'speech.recorded',
          '2026-03-10T00:01:01.000Z',
          {
            agent: 'alpha',
            content: 'Final speech before end.',
            decrementQuota: true,
            recordLastSpeechStep: 1,
          },
        ),
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

  it('skips abort-ended snapshots during recovery', async () => {
    const harness = createDiscussHarness();
    await persistSession(harness, {
      sessionId: 'discuss-abort-ended',
      recover: false,
      buildTail: (snapshot) => [
        makeEvent(
          snapshot.sessionId,
          harness.projectRoot,
          snapshot.state.topic,
          snapshot.lastAppliedSeq + 1,
          'session.ended',
          '2026-03-10T00:01:00.000Z',
          {
            endReasonContent: 'abort',
            force: true,
            reason: 'abort',
          },
        ),
      ],
    });

    const recovered = await recoverSessions(harness);

    expect(recovered).toHaveLength(0);
    expect(getSession(harness.context, 'discuss-abort-ended')).toBeUndefined();

    harness.cleanup();
  });
});
