import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS } from '#src/coordinator/services/execution-policies.js';
import { makeEvent } from '#src/discuss/events.js';
import * as discussLoop from '#src/discuss/shell/loop.js';
import * as discussSpeechFlow from '#src/discuss/shell/flow/speech.js';
import {
  createDiscussContextRegistry,
  get as getDiscussContext,
  getOrCreate as getOrCreateDiscussContext,
  hasRunningSessions,
} from '#src/discuss/shell/live-registry.js';
import { PURPOSE_BID, PURPOSE_SPEECH, executeAgentAttempt, runPlainTurn } from '#src/discuss/shell/runtime-build.js';
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
  discussContextOptions,
  persistSession,
  type DiscussHarness,
} from '#tests/unit/discuss/shell/discuss-test-helpers.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_CODEX_SCOPE, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

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
      projectRoot: fixtureCanonicalWorkDir(snapshot.projectRoot),
      pluginRoot: harness.ctx.pluginRoot,
      coralEnv: {},
      principal: testProjectPrincipal(snapshot.projectRoot),
      providerScope: snapshot.providerScope ?? TEST_PROVIDER_SCOPE,
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

describe('Discuss provider scope', () => {
  it('rejects an incomplete mixed-provider scope before durable discussion allocation', async () => {
    const harness = createDiscussHarness();

    await expect(
      startDiscussSession(
        harness.context,
        'incomplete-provider-scope',
        DEFAULT_TOPIC,
        [
          { name: 'alpha', persona: '# Alpha', provider: 'codex' },
          { name: 'beta', persona: '# Beta', provider: 'claude' },
        ],
        {},
        { ...harness.ctx, providerScope: TEST_CODEX_SCOPE },
      ),
    ).rejects.toMatchObject({
      code: 'provider_binding_missing_profile',
      detail: { message: expect.stringContaining('Claude credential profile') },
    });

    expect(harness.store.load('incomplete-provider-scope')).toBeNull();
    expect(harness.service.start).not.toHaveBeenCalled();

    harness.cleanup();
  });
});

describe('Discuss executor and operations', () => {
  it('passes the canonical target cwd through a discuss launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-discuss-canonical-'));
    const physicalProject = join(root, 'physical-project');
    const selectedProject = join(root, 'selected-project');
    mkdirSync(physicalProject);
    symlinkSync(physicalProject, selectedProject, 'dir');
    const start = vi.fn().mockResolvedValue({
      kind: 'provider-session',
      status: 'running',
      jobId: 'job-canonical',
      sessionId: 'exec-canonical',
    });
    const harness = createDiscussHarness(
      createExecutionServiceStub({
        start,
        waitStreamOnce: vi.fn().mockResolvedValue({ content: 'done', continuity: null }),
      }),
      { projectRoot: physicalProject },
    );
    await persistSession(harness, { sessionId: 'canonical-discuss', recover: true });
    const canonicalProject = canonicalizeWorkDir(selectedProject, root);
    const invocationCtx = {
      ...harness.ctx,
      projectRoot: canonicalProject,
      principal: testProjectPrincipal(canonicalProject),
    };

    try {
      await runPlainTurn(harness.context, {
        agentName: 'alpha',
        sessionId: 'canonical-discuss',
        provider: 'codex',
        model: undefined,
        prompt: 'Speak',
        instruction: 'Use the canonical cwd.',
        cwd: canonicalProject,
        invocationCtx,
        purpose: PURPOSE_SPEECH,
      });

      expect(start.mock.calls[0][1].cwd).toBe(realpathSync(physicalProject));
      expect(start.mock.calls[0][2].projectRoot).toBe(realpathSync(physicalProject));
    } finally {
      harness.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a provider preflight deadline as undetermined without consuming an attempt', async () => {
    const start = vi.fn();
    const waitStreamOnce = vi.fn();
    const harness = createDiscussHarness(createExecutionServiceStub({ start, waitStreamOnce }));
    start.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        harness.runtime.time.setTimeout(resolve, PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS);
      });
      return {
        status: 'undetermined',
        code: 'provider_preflight_undetermined',
        message: `codex preflight timed out after ${PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS}ms`,
      } as const;
    });
    await persistSession(harness, { sessionId: 'discuss-undetermined-launch', recover: true });

    const attempt = executeAgentAttempt(harness.context, {
      agentName: 'alpha',
      sessionId: 'discuss-undetermined-launch',
      provider: 'codex',
      model: 'gpt-5',
      prompt: 'Bid now',
      instruction: 'System turn contract',
      cwd: harness.ctx.projectRoot,
      invocationCtx: harness.ctx,
      purpose: PURPOSE_BID,
    });

    await advanceDiscussRuntime(harness, PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS);

    await expect(attempt).resolves.toEqual({
      ok: false,
      consumedAttempt: false,
      message: `Discuss launch check established nothing: codex preflight timed out after ${PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS}ms`,
    });
    expect(waitStreamOnce).not.toHaveBeenCalled();

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

    const recovered = await recoverSessions(harness);

    expect(recovered).toHaveLength(0);
    expect(getSession(harness.context, 'discuss-recovery')).toBeUndefined();
    expect(getWatchState(harness.context, 'discuss-recovery')).toMatchObject({
      cursor: 2,
    });
    expect(getWatchState(harness.context, 'discuss-recovery', 1)).toMatchObject({
      cursor: 2,
    });

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
});
