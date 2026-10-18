import { describe, expect, it, vi } from 'vitest';

import {
  finalizeInterruptedAppServerRecovery,
  finalizeInterruptedDurableRecovery,
} from '#src/coordinator/services/recovery/interrupted-finalizer.js';
import type { InterruptedRecoveryCommitError } from '#src/coordinator/services/recovery/interrupted-finalizer.js';
import type {
  AppServerInterruptedRecoveryPlan,
  DurableInterruptedRecoveryPlan,
  ProviderOperationCarrierRecord,
} from '#src/coordinator/services/recovery/interrupted-plan.js';
import { planInterruptedAppServerRecovery } from '#src/coordinator/services/recovery/interrupted-plan.js';
import type {
  PerformedDurableRecovery,
  PerformedInterruptedRecovery,
} from '#src/coordinator/services/recovery/interrupted-performer.js';
import { performInterruptedAppServerRecovery } from '#src/coordinator/services/recovery/interrupted-performer.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import type { ProviderRecoveryAuthority } from '#src/jobs/reconcile/contracts.js';
import type { JobStatus } from '#src/jobs/records.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { codexRecoveryLifecycle } from '#src/providers/codex/provider-facets.js';
import type { ProviderValidatedSessionContinuityMutation } from '#src/sessions/continuity-mutation.js';
import { validatedTestContinuityBlob } from '#tests/helpers/session.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const plan = {
  kind: 'interrupted',
  launchRecord: {
    jobId: 'interrupted-job',
    sessionId: 'interrupted-session',
    provider: 'fixture',
    projectRoot: '/project',
    backendNamespace: 'namespace',
    pool: 'default',
  },
  session: {
    sessionId: 'interrupted-session',
    version: 7,
    conversationRef: 'thread-recovered',
    providerContinuity: validatedTestContinuityBlob({ threadId: 'thread-recovered', turnId: 'turn-active' }),
  },
  runtimeRecord: {
    startTime: '2026-07-22T00:00:00.000Z',
    providerMeta: {
      leaseState: 'acquired',
      hostRef: { provider: 'fixture', hostId: 'host-interrupted', generation: 1 },
    },
  },
  reason: 'restart',
  expectedSessionVersion: 7,
} as unknown as AppServerInterruptedRecoveryPlan;

const status = {
  jobId: 'interrupted-job',
  sessionId: 'interrupted-session',
  backendNamespace: 'namespace',
  projectRoot: '/project',
} as JobStatus;

const performed = {
  kind: 'resolved',
  mutation: {
    kind: 'set_resumable',
    conversationRef: 'thread-recovered',
    providerContinuity: validatedTestContinuityBlob({ threadId: 'thread-recovered' }),
  },
} satisfies PerformedInterruptedRecovery;

const durablePlan = {
  kind: 'durable-artifacts',
  launchRecord: plan.launchRecord,
  session: plan.session,
  runtimeRecord: {
    transport: 'durable-cli',
    pid: 42,
    stdoutPath: '/jobs/interrupted-job/stdout',
    stderrPath: '/jobs/interrupted-job/stderr',
    startTime: '2026-07-22T00:00:00.000Z',
  },
  exit: {
    exitCode: 0,
    signal: null,
    endTime: '2026-07-22T00:01:00.000Z',
  },
  expectedSessionVersion: 7,
} as unknown as DurableInterruptedRecoveryPlan;

const durablePerformed = {
  kind: 'durable-resolved',
  terminal: {
    kind: 'provider',
    value: {
      kind: 'terminal',
      terminal: { content: 'recovered', durationMs: 60_000, outcome: { kind: 'completed' } },
      diagnostics: {},
    },
  },
  mutation: {
    kind: 'set_resumable',
    conversationRef: 'thread-recovered',
    providerContinuity: { threadId: 'thread-recovered' },
  },
  artifactHandles: [
    {
      handle: '/provider/thread-recovered.jsonl',
      identity: { kind: 'fixture', threadId: 'thread-recovered' },
    },
  ],
} as unknown as PerformedDurableRecovery;

function createHarness(
  options: { artifactRecorded?: boolean; sessionFinalized?: boolean; sessionFinalizeError?: Error } = {},
) {
  const order: string[] = [];
  const append = vi.fn(() => {
    order.push('terminal');
    return {} as never;
  });
  const recordArtifactHandleAtomic = vi.fn(async () => {
    order.push('artifact-cas');
    return options.artifactRecorded === false ? ({ ok: false } as const) : ({ ok: true, nextVersion: 8 } as const);
  });
  const finalizeJobContinuityAtomic = vi.fn(async (_sessionId, commitOptions) => {
    order.push('session-cas');
    if (options.sessionFinalizeError !== undefined) throw options.sessionFinalizeError;
    if (options.sessionFinalized === false) return false;
    commitOptions.appendBeforeRelease?.({ append });
    return true;
  });
  const remove = vi.fn(() => order.push('abort-remove'));
  const launchCoordinator = new LaunchCoordinator({ runtime: new SimulationRuntime() });
  const launchPermit = launchCoordinator.restoreActiveLaunch(
    'interrupted-job',
    'fixture',
    { kind: 'provider-session', id: 'interrupted-session' },
    'default',
  );
  const releaseExact = launchCoordinator.releaseLaunch.bind(launchCoordinator);
  const releaseLaunch = vi.spyOn(launchCoordinator, 'releaseLaunch').mockImplementation((permit) => {
    order.push('admission-release');
    return releaseExact(permit);
  });
  const publishTerminalResult = vi.fn((jobId: string) => {
    order.push('artifact-publish');
    return `/jobs/${jobId}/result.md`;
  });

  return {
    order,
    append,
    recordArtifactHandleAtomic,
    finalizeJobContinuityAtomic,
    remove,
    releaseLaunch,
    launchCoordinator,
    launchPermit,
    publishTerminalResult,
    deps: {
      runtime: {
        time: { now: () => Date.parse('2026-07-22T00:01:00.000Z') },
      },
      sessionManager: { recordArtifactHandleAtomic, finalizeJobContinuityAtomic },
      abortRegistry: { remove },
      launchAdmission: launchCoordinator,
      launchPermit,
      publishTerminalResult,
    } as never,
  };
}

function createRecoveryProvider() {
  const finalizeInterrupted = vi.fn(codexRecoveryLifecycle.finalizeInterrupted);
  const finalizeFromArtifacts = vi.fn();
  const openReplacement = vi.fn();
  return {
    finalizeInterrupted,
    finalizeFromArtifacts,
    openReplacement,
    boundProvider: {
      recovery: { finalizeInterrupted, finalizeFromArtifacts },
      appServer: { openReplacement },
    } as unknown as BoundProvider,
  };
}

describe('interrupted app-server recovery performer', () => {
  it('keeps unsupported recovery free of provider and carrier effects', async () => {
    const provider = createRecoveryProvider();
    const recoveryPlan = planInterruptedAppServerRecovery(
      { launchRecord: plan.launchRecord, session: plan.session } as ProviderRecoveryAuthority,
      plan.runtimeRecord,
      'restart',
      { recovery: false },
      null,
    );
    const reapCarrier = vi.fn();

    expect(recoveryPlan.kind).toBe('unsupported');
    await expect(
      performInterruptedAppServerRecovery(recoveryPlan, provider.boundProvider, { reapCarrier }),
    ).resolves.toEqual({ kind: 'unsupported' });

    expect(provider.finalizeInterrupted).not.toHaveBeenCalled();
    expect(provider.openReplacement).not.toHaveBeenCalled();
    expect(provider.finalizeFromArtifacts).not.toHaveBeenCalled();
    expect(reapCarrier).not.toHaveBeenCalled();
  });

  it.each([
    { conversationRef: 'thread-recovered', continuity: undefined, mutationKind: 'set_resumable' },
    { conversationRef: undefined, continuity: validatedTestContinuityBlob({}), mutationKind: 'preserve' },
    { conversationRef: undefined, continuity: undefined, mutationKind: 'clear_non_resumable' },
  ])(
    'uses $mutationKind for recorded reference and continuity',
    async ({ conversationRef, continuity, mutationKind }) => {
      const provider = createRecoveryProvider();
      const recoveryPlan = planInterruptedAppServerRecovery(
        {
          launchRecord: plan.launchRecord,
          session: { ...plan.session, conversationRef, providerContinuity: continuity ?? null },
        } as ProviderRecoveryAuthority,
        plan.runtimeRecord,
        'restart',
        { recovery: true },
        null,
      );

      await expect(
        performInterruptedAppServerRecovery(recoveryPlan, provider.boundProvider, { reapCarrier: vi.fn() }),
      ).resolves.toMatchObject({ kind: 'resolved', mutation: { kind: mutationKind } });
      expect(provider.finalizeInterrupted).toHaveBeenCalledWith(
        {
          resumable: conversationRef !== undefined || continuity !== undefined,
          ...(continuity === undefined ? {} : { updatedContinuity: continuity }),
        },
        continuity,
        { preservedConversationRef: conversationRef },
      );
    },
  );

  it.each(['waiting', 'acquired'] as const)(
    'preserves the checkpointed conversation without provider I/O for a %s lease',
    async (leaseState) => {
      const provider = createRecoveryProvider();
      const harness = createHarness();
      const runtimeRecord = {
        ...plan.runtimeRecord,
        providerMeta: { ...plan.runtimeRecord.providerMeta, leaseState },
      } as typeof plan.runtimeRecord;
      const recoveryPlan = planInterruptedAppServerRecovery(
        { launchRecord: plan.launchRecord, session: plan.session } as ProviderRecoveryAuthority,
        runtimeRecord,
        'restart',
        { recovery: true },
        null,
      );
      const reapCarrier = vi.fn();

      expect(recoveryPlan.kind).toBe('interrupted');
      const result = await performInterruptedAppServerRecovery(recoveryPlan, provider.boundProvider, {
        reapCarrier,
      });
      await finalizeInterruptedAppServerRecovery(recoveryPlan, result, status, harness.deps);

      expect(provider.finalizeInterrupted).toHaveBeenCalledWith(
        { resumable: true, updatedContinuity: plan.session.providerContinuity },
        plan.session.providerContinuity,
        { preservedConversationRef: 'thread-recovered' },
      );
      expect(harness.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
        'interrupted-session',
        expect.objectContaining({
          mutation: expect.objectContaining({ kind: 'set_resumable', conversationRef: 'thread-recovered' }),
        }),
      );
      expect(provider.openReplacement).not.toHaveBeenCalled();
      expect(provider.finalizeFromArtifacts).not.toHaveBeenCalled();
      expect(reapCarrier).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])('uses only recorded continuity when a carrier is present: %s', async (hasContinuity) => {
    const provider = createRecoveryProvider();
    const carrier = {} as ProviderOperationCarrierRecord;
    const session = {
      ...plan.session,
      providerContinuity: hasContinuity ? plan.session.providerContinuity : null,
    };
    const recoveryPlan = planInterruptedAppServerRecovery(
      { launchRecord: plan.launchRecord, session } as ProviderRecoveryAuthority,
      plan.runtimeRecord,
      'restart',
      { recovery: true },
      carrier,
    );
    const harness = createHarness();
    let finishReap!: () => void;
    const reapCarrier = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishReap = resolve;
        }),
    );

    expect(recoveryPlan.kind).toBe('carrier-detached');
    const settlement = performInterruptedAppServerRecovery(recoveryPlan, provider.boundProvider, {
      reapCarrier,
    }).then((result) => finalizeInterruptedAppServerRecovery(recoveryPlan, result, status, harness.deps));

    expect(reapCarrier).toHaveBeenCalledWith(carrier);
    expect(provider.finalizeInterrupted).not.toHaveBeenCalled();
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.finalizeJobContinuityAtomic).not.toHaveBeenCalled();

    finishReap();
    await settlement;

    expect(provider.finalizeInterrupted).toHaveBeenCalledWith(
      {
        resumable: true,
        ...(hasContinuity ? { updatedContinuity: session.providerContinuity } : {}),
      },
      hasContinuity ? session.providerContinuity : undefined,
      { preservedConversationRef: 'thread-recovered' },
    );
    expect(harness.append).toHaveBeenCalled();
    expect(provider.openReplacement).not.toHaveBeenCalled();
    expect(provider.finalizeFromArtifacts).not.toHaveBeenCalled();
  });

  it('leaves the job non-terminal and retains ownership when carrier reaping rejects', async () => {
    const provider = createRecoveryProvider();
    const harness = createHarness();
    const carrier = {} as ProviderOperationCarrierRecord;
    const recoveryPlan = { ...plan, kind: 'carrier-detached', carrier } as AppServerInterruptedRecoveryPlan;
    const failure = new Error('carrier absence unconfirmed');
    const reapCarrier = vi.fn().mockRejectedValue(failure);

    await expect(
      performInterruptedAppServerRecovery(recoveryPlan, provider.boundProvider, { reapCarrier }).then((result) =>
        finalizeInterruptedAppServerRecovery(recoveryPlan, result, status, harness.deps),
      ),
    ).rejects.toBe(failure);

    expect(provider.finalizeInterrupted).not.toHaveBeenCalled();
    expect(harness.finalizeJobContinuityAtomic).not.toHaveBeenCalled();
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
  });
});

describe('interrupted app-server recovery finalizer', () => {
  it('records a provider-acknowledged user cancellation as user_abort', async () => {
    const harness = createHarness();
    const userAbortPlan = { ...plan, reason: 'user_abort' } as unknown as AppServerInterruptedRecoveryPlan;

    await finalizeInterruptedAppServerRecovery(userAbortPlan, { kind: 'user-aborted' }, status, harness.deps);

    expect(harness.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
      'interrupted-session',
      expect.objectContaining({
        expectedActiveJobId: 'interrupted-job',
        expectedVersion: 7,
        mutation: { kind: 'preserve' },
      }),
    );
    expect(harness.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'job.terminal.recorded',
        body: expect.objectContaining({
          terminal: expect.objectContaining({ outcome: { kind: 'aborted', reason: 'user_abort' } }),
        }),
      }),
    );
    expect(harness.remove).toHaveBeenCalledWith('interrupted-job');
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toBeNull();
  });

  it('settles without artifact writes using the captured session version', async () => {
    const harness = createHarness();

    await finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps);

    expect(harness.recordArtifactHandleAtomic).not.toHaveBeenCalled();
    expect(harness.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
      'interrupted-session',
      expect.objectContaining({
        expectedActiveJobId: 'interrupted-job',
        expectedVersion: 7,
        mutation: {
          kind: 'set_resumable',
          conversationRef: 'thread-recovered',
          providerContinuity: { threadId: 'thread-recovered' },
        },
        appendBeforeRelease: expect.any(Function),
      }),
    );
    expect(harness.order).toEqual([
      'session-cas',
      'terminal',
      'terminal',
      'artifact-publish',
      'abort-remove',
      'admission-release',
    ]);
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toBeNull();
  });

  it.each<{
    mutation: ProviderValidatedSessionContinuityMutation;
    continuity: string;
  }>([
    { mutation: performed.mutation, continuity: 'pre_checkpoint_preserved' },
    { mutation: { kind: 'preserve' }, continuity: 'pre_checkpoint_preserved' },
    { mutation: { kind: 'clear_non_resumable' }, continuity: 'pre_checkpoint_empty' },
  ])('records $continuity for $mutation.kind', async ({ mutation, continuity }) => {
    const harness = createHarness();

    await finalizeInterruptedAppServerRecovery(plan, { kind: 'resolved', mutation }, status, harness.deps);

    expect(harness.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.interrupted',
        body: { trigger: 'restart', continuity },
      }),
    );
  });

  it('preserves local ownership when the final session CAS is stale', async () => {
    const harness = createHarness({ sessionFinalized: false });

    await expect(finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps)).rejects.toEqual(
      expect.objectContaining<Partial<InterruptedRecoveryCommitError>>({
        name: 'InterruptedRecoveryCommitError',
        stage: 'session-finalize',
      }),
    );

    expect(harness.order).toEqual(['session-cas']);
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });

  it('preserves local ownership when the final session CAS throws', async () => {
    const harness = createHarness({ sessionFinalizeError: new Error('session store unavailable') });

    await expect(finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps)).rejects.toThrow(
      'session store unavailable',
    );

    expect(harness.order).toEqual(['session-cas']);
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });
});

describe('interrupted durable recovery finalizer', () => {
  it('uses the same exact-version CAS and ownership-release boundary', async () => {
    const harness = createHarness();

    await finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps);

    expect(harness.recordArtifactHandleAtomic).toHaveBeenCalledWith('interrupted-session', {
      expectedActiveJobId: 'interrupted-job',
      expectedVersion: 7,
      handle: '/provider/thread-recovered.jsonl',
      identity: { kind: 'fixture', threadId: 'thread-recovered' },
      sourceJobId: 'interrupted-job',
    });
    expect(harness.finalizeJobContinuityAtomic).toHaveBeenCalledWith(
      'interrupted-session',
      expect.objectContaining({
        expectedActiveJobId: 'interrupted-job',
        expectedVersion: 8,
        mutation: durablePerformed.mutation,
        appendBeforeRelease: expect.any(Function),
      }),
    );
    expect(harness.order).toEqual([
      'artifact-cas',
      'session-cas',
      'terminal',
      'artifact-publish',
      'abort-remove',
      'admission-release',
    ]);
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toBeNull();
  });

  it('does not persist a durable terminal when the exact final session CAS is stale', async () => {
    const harness = createHarness({ sessionFinalized: false });

    await expect(
      finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'InterruptedRecoveryCommitError',
        stage: 'session-finalize',
      }),
    );

    expect(harness.order).toEqual(['artifact-cas', 'session-cas']);
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });

  it('does not terminalize or release ownership after stale artifact evidence', async () => {
    const harness = createHarness({ artifactRecorded: false });

    await expect(
      finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'InterruptedRecoveryCommitError',
        stage: 'artifact-handle',
      }),
    );

    expect(harness.recordArtifactHandleAtomic).toHaveBeenCalled();
    expect(harness.order).toEqual(['artifact-cas']);
    expect(harness.launchCoordinator.reservationFor('interrupted-job')).toMatchObject({ kind: 'active' });
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
  });
});
