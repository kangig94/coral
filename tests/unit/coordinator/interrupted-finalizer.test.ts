import { RecoveryService } from '#src/coordinator/services/recovery/service.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import {
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationForJob,
} from '#src/store/provider-operation-journal.js';
import { afterEach } from 'vitest';
import { executionHarness, openedJob, requestedExecution } from '#tests/helpers/job-executions.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { testJobConversation } from '#tests/helpers/session.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { JobStore } from '#src/jobs/store.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import {
  ExecutionAcceptanceRefusedError,
  ExecutionFinisher,
  readExecutionFinishingState,
} from '#src/jobs/finishing.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { ProviderRecoveryLaunch } from '#src/jobs/reconcile/contracts.js';
import { describe, expect, it, vi } from 'vitest';

import {
  finalizeInterruptedAppServerRecovery,
  finalizeInterruptedDurableRecovery,
} from '#src/coordinator/services/recovery/interrupted-finalizer.js';
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
import { claudeRecoveryLifecycle } from '#src/providers/claude/provider-facets.js';
import type { ProviderValidatedSessionContinuityMutation } from '#src/jobs/conversation/continuity-mutation.js';
import { validatedTestContinuityBlob } from '#tests/helpers/session.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { FailureDomainObservation } from '#src/infra/failure-domain.js';
import { ProcessContainmentError, createFailureDomainAbsenceObserver } from '#src/infra/process-containment.js';

const launchRecord: ProviderRecoveryLaunch = {
  jobId: '0589caa7-f637-5cc3-834e-aa56ebcb2ac5',
  execution: 1,
  owner: { kind: 'provider-session', id: '0589caa7-f637-5cc3-834e-aa56ebcb2ac5' },
  provider: 'fixture',
  jobKind: 'provider',
  projectRoot: '/project',
  backendNamespace: 'namespace',
  pool: 'default',
  enqueueSequence: 1,
  providerAction: 'exec',
  request: { prompt: 'recover', cwd: '/project', bypassPermissions: false, coralEnv: {} },
  createdAt: '2026-07-22T00:00:00.000Z',
};
const recoveredSession = testJobConversation(launchRecord.jobId, {
  execution: 1,
  open: true,
  projectRoot: '/project',
  cwd: fixtureCanonicalWorkDir('/project'),
  provider: 'fixture',
  binding: { ...TEST_CODEX_BINDING, provider: 'fixture' },
  conversationRef: 'thread-recovered',
  providerContinuity: validatedTestContinuityBlob({ threadId: 'thread-recovered', turnId: 'turn-active' }),
});
const plan: AppServerInterruptedRecoveryPlan = {
  kind: 'interrupted',
  launchRecord,
  session: recoveredSession,
  runtimeRecord: {
    transport: 'app-server',
    startTime: '2026-07-22T00:00:00.000Z',
    providerMeta: {
      provider: 'fixture',
      leaseState: 'acquired',
      hostRef: {
        provider: 'fixture',
        fingerprint: 'f'.repeat(64),
        instanceId: 'host-interrupted',
        leaseMode: 'shared',
      },
    },
  },
  reason: 'restart',
  continuity: recoveredSession.providerContinuity ?? undefined,
  preservedConversationRef: recoveredSession.conversationRef,
};
const status: JobStatus = {
  jobId: launchRecord.jobId,
  execution: 1,
  owner: launchRecord.owner,
  provider: 'fixture',
  sessionId: null,
  backendNamespace: 'namespace',
  projectRoot: '/project',
  workDir: recoveredSession.cwd,
  jobKind: 'provider',
  phase: 'running',
  updatedAt: launchRecord.createdAt,
};

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

const journals: ReturnType<typeof executionHarness>[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.db.close();
});

function createHarness(
  options: {
    artifactRecorded?: boolean;
    sessionFinalized?: boolean;
    sessionFinalizeError?: Error;
    requireOperationRelease?: boolean;
  } = {},
) {
  const runtime = new SimulationRuntime({ epochMs: Date.parse('2026-07-22T00:01:00.000Z') });
  const journal = executionHarness();
  journals.push(journal);
  const stream = { kind: 'job', id: launchRecord.jobId } as const;
  journal.append(
    {
      ...openedJob({
        owner: launchRecord.owner,
        projectRoot: '/project',
        conversation: {
          provider: recoveredSession.provider,
          binding: recoveredSession.binding,
          cwd: recoveredSession.cwd,
          name: recoveredSession.name,
          bypassPermissions: false,
          retention: 'retain',
        },
      }),
      stream,
    },
    { ...requestedExecution(1), stream },
  );
  const order: string[] = [];
  const append = vi.fn();
  let blocked = options.sessionFinalized === false || options.sessionFinalizeError !== undefined;
  let artifactBlocked = options.artifactRecorded === false;
  const store = new JobStore('namespace', runtime, journal.ctx.bodyCodec, {
    db: journal.db,
    reducers: journal.ctx.reducers,
    providers: journal.ctx.providers,
    beforeAppend: (input) => {
      if (artifactBlocked && input.type === 'job.artifact.recorded')
        throw Object.assign(new Error('artifact store unavailable'), { code: 'EIO' });
    },
    observer: (events) => {
      for (const event of events) {
        append(event);
        order.push(event.type);
      }
    },
  });
  const conversationManager = new ConversationManager('/project', runtime, (write) => store.commit(write), journal.db);
  const readExact = conversationManager.readById.bind(conversationManager);
  const readById = vi.spyOn(conversationManager, 'readById').mockImplementation((jobId) => {
    if (blocked) {
      if (options.sessionFinalizeError !== undefined) throw options.sessionFinalizeError;
      return null;
    }
    return readExact(jobId);
  });
  const finisher = new ExecutionFinisher({
    time: runtime.time,
    commit: (write) => store.commit(write),
    read: (address) => readExecutionFinishingState(journal.db, address, store),
    quiesce: async (address) =>
      !abortRegistry.has(address.jobId, address.execution) &&
      launchCoordinator.reservationFor(address.jobId) === null &&
      (!options.requireOperationRelease || readProviderOperationForJob(journal.db, address.jobId) === null),
    retentionAction: async () => ({ attempt: 0, handles: [] }),
    settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
  });
  const abortRegistry = new AbortRegistry();
  abortRegistry.register(launchRecord.jobId, 1);
  const removeExact = abortRegistry.remove.bind(abortRegistry);
  const remove = vi.spyOn(abortRegistry, 'remove').mockImplementation((jobId, execution) => {
    order.push('abort-remove');
    removeExact(jobId, execution);
  });
  const launchCoordinator = new LaunchCoordinator({ runtime });
  const launchPermit = launchCoordinator.restoreActiveLaunch(
    launchRecord.jobId,
    'fixture',
    launchRecord.owner,
    'default',
  );
  const releaseExact = launchCoordinator.releaseLaunch.bind(launchCoordinator);
  const releaseLaunch = vi.spyOn(launchCoordinator, 'releaseLaunch').mockImplementation((permit) => {
    order.push('admission-release');
    return releaseExact(permit);
  });
  return {
    order,
    append,
    readById,
    remove,
    releaseLaunch,
    launchCoordinator,
    launchPermit,
    store,
    journal,
    finish: async () => {
      runtime.time.tick(500);
      await finisher.finish(launchRecord);
    },
    repairWrites: async () => {
      blocked = false;
      artifactBlocked = false;
      runtime.time.tick(500);
      for (let index = 0; index < 50; index += 1) await Promise.resolve();
    },
    deps: {
      runtime,
      conversationManager,
      executionFinisher: finisher,
      abortRegistry,
      launchAdmission: launchCoordinator,
      launchPermit,
      finalizationFence: { signal: new AbortController().signal, onCommitStart: () => {} },
    },
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
  it('preserves Claude conversation and bootstrap continuity while clearing broker turn continuity', async () => {
    const bootstrapSignature = {
      cwd: '/project',
      systemPromptHash: 'system-hash',
      permissionMode: 'default',
      bootstrapConfigHash: 'config-hash',
    };
    const recoveryPlan = planInterruptedAppServerRecovery(
      {
        launchRecord: plan.launchRecord,
        session: {
          ...plan.session,
          providerContinuity: validatedTestContinuityBlob({
            bootstrapSignature,
            brokerSessionKey: 'broker-session',
            brokerTurnId: 'interrupted-turn',
          }),
        },
      } as unknown as ProviderRecoveryAuthority,
      plan.runtimeRecord,
      'restart',
      { recovery: true },
      null,
    );
    const boundProvider = { recovery: claudeRecoveryLifecycle } as unknown as BoundProvider;

    await expect(
      performInterruptedAppServerRecovery(recoveryPlan, boundProvider, { reapCarrier: vi.fn() }),
    ).resolves.toEqual({
      kind: 'resolved',
      mutation: {
        kind: 'set_resumable',
        conversationRef: 'thread-recovered',
        providerContinuity: { bootstrapSignature },
      },
    });
  });

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
    {
      conversationRef: undefined,
      continuity: validatedTestContinuityBlob({ cwd: '/project' }),
      mutationKind: 'preserve',
    },
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
      expect(result).toEqual({
        kind: 'resolved',
        mutation: {
          kind: 'set_resumable',
          conversationRef: 'thread-recovered',
          providerContinuity: { threadId: 'thread-recovered' },
        },
      });
      await finalizeInterruptedAppServerRecovery(recoveryPlan, result, status, harness.deps);
      await harness.finish();

      expect(provider.finalizeInterrupted).toHaveBeenCalledWith({ resumable: true }, plan.session.providerContinuity, {
        preservedConversationRef: 'thread-recovered',
      });
      expect(harness.store.readStatus(launchRecord.jobId)?.phase).toBe('error');
      expect(harness.journal.events()).toContainEqual(
        expect.objectContaining({
          type: 'job.continuity.checkpointed',
          body: expect.objectContaining({ snapshot: expect.objectContaining({ conversationRef: 'thread-recovered' }) }),
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
    expect(harness.readById).not.toHaveBeenCalled();

    finishReap();
    await settlement;
    await harness.finish();

    expect(provider.finalizeInterrupted).toHaveBeenCalledWith(
      {
        resumable: true,
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
    expect(harness.readById).not.toHaveBeenCalled();
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor('0589caa7-f637-5cc3-834e-aa56ebcb2ac5')).toMatchObject({
      kind: 'active',
    });
  });
});

describe('interrupted app-server recovery finalizer', () => {
  it('records a provider-acknowledged user cancellation as user_abort', async () => {
    const harness = createHarness();
    const userAbortPlan = { ...plan, reason: 'user_abort' } as const;
    await finalizeInterruptedAppServerRecovery(userAbortPlan, { kind: 'user-aborted' }, status, harness.deps);
    await harness.finish();
    expect(harness.store.readTerminalProjection(launchRecord.jobId)?.outcome).toEqual({
      kind: 'aborted',
      reason: 'user_abort',
    });
    expect(harness.readById).toHaveBeenCalledWith(launchRecord.jobId);
    expect(harness.remove).toHaveBeenCalledWith(launchRecord.jobId, 1);
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toBeNull();
  });

  it('settles continuity and the accepted outcome atomically before ending and releasing ownership', async () => {
    const harness = createHarness();
    await finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps);
    await harness.finish();
    expect(harness.journal.events().filter((event) => event.type === 'job.artifact.recorded')).toEqual([]);
    expect(harness.journal.events()).toContainEqual(
      expect.objectContaining({
        type: 'job.continuity.checkpointed',
        body: {
          execution: 1,
          snapshot: {
            conversationRef: 'thread-recovered',
            resumable: true,
            providerContinuity: { threadId: 'thread-recovered' },
          },
        },
      }),
    );
    expect(harness.order).toEqual([
      'job.continuity.checkpointed',
      'job.interrupted',
      'job.execution.outcome.accepted',
      'abort-remove',
      'admission-release',
      'job.execution.ended',
    ]);
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toBeNull();
  });

  it.each<{ mutation: ProviderValidatedSessionContinuityMutation; continuity: string }>([
    { mutation: performed.mutation, continuity: 'pre_checkpoint_preserved' },
    { mutation: { kind: 'preserve' }, continuity: 'pre_checkpoint_preserved' },
    { mutation: { kind: 'clear_non_resumable' }, continuity: 'pre_checkpoint_empty' },
  ])('records $continuity for $mutation.kind', async ({ mutation, continuity }) => {
    const harness = createHarness();
    await finalizeInterruptedAppServerRecovery(plan, { kind: 'resolved', mutation }, status, harness.deps);
    await harness.finish();
    expect(harness.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'job.interrupted',
        body: { execution: 1, trigger: 'restart', continuity },
      }),
    );
  });

  it('returns a deterministic checkpoint refusal to recovery without releasing original ownership', async () => {
    const harness = createHarness({ sessionFinalized: false });
    await expect(finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps)).rejects.toMatchObject({
      name: 'InterruptedRecoveryCommitError',
    });
    expect(harness.deps.executionFinisher.owns(launchRecord)).toBe(false);
    expect(harness.deps.executionFinisher.status(launchRecord)).toBeNull();
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toMatchObject({ kind: 'active' });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
    await harness.repairWrites();
    await finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps);
    await harness.finish();
    expect(harness.store.readStatus(launchRecord.jobId)?.phase).toBe('error');
  });

  it('preserves local ownership across a checkpoint store failure and retries the original outcome', async () => {
    const harness = createHarness({
      sessionFinalizeError: Object.assign(new Error('session store unavailable'), { code: 'EIO' }),
    });
    const pending = finalizeInterruptedAppServerRecovery(plan, performed, status, harness.deps);
    await Promise.resolve();
    expect(harness.readById).toHaveBeenCalled();
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toMatchObject({ kind: 'active' });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
    await harness.repairWrites();
    await pending;
    await harness.finish();
    expect(harness.journal.events().filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
  });
});

describe('interrupted durable recovery finalizer', () => {
  it.each<FailureDomainObservation>([
    { kind: 'populated' },
    { kind: 'missing' },
    { kind: 'unknown', reason: 'EACCES' },
  ])('retains ownership when the leaf becomes $kind before the actual acceptance commit', async (changed) => {
    const harness = createHarness();
    let observation: FailureDomainObservation = { kind: 'absent' };
    const permitsIndependentAbsenceDecision = createFailureDomainAbsenceObserver({ observe: () => observation });
    expect(permitsIndependentAbsenceDecision()).toBe(true);
    const pending = finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, {
      ...harness.deps,
      finalizationFence: {
        signal: new AbortController().signal,
        onCommitStart: () => {
          if (!permitsIndependentAbsenceDecision()) throw new Error('Leaf absence is no longer observable.');
        },
      },
    });
    observation = changed;
    await expect(pending).rejects.toBeInstanceOf(ExecutionAcceptanceRefusedError);
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toMatchObject({ kind: 'active' });
    expect(harness.deps.abortRegistry.has(launchRecord.jobId, 1)).toBe(true);
  });

  it.each<FailureDomainObservation>([
    { kind: 'populated' },
    { kind: 'missing' },
    { kind: 'unknown', reason: 'EACCES' },
  ])('retains local ownership when the leaf becomes $kind after acceptance commits', async (changed) => {
    const harness = createHarness();
    let observation: FailureDomainObservation = { kind: 'absent' };
    const permitsIndependentAbsenceDecision = createFailureDomainAbsenceObserver({ observe: () => observation });
    expect(permitsIndependentAbsenceDecision()).toBe(true);
    harness.append.mockImplementation((event) => {
      if (event.type === 'job.execution.outcome.accepted') observation = changed;
    });
    await expect(
      finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, {
        ...harness.deps,
        finalizationFence: {
          signal: new AbortController().signal,
          onCommitStart: () => {
            if (!permitsIndependentAbsenceDecision()) throw new Error('Leaf absence is no longer observable.');
          },
        },
      }),
    ).rejects.toBeInstanceOf(ExecutionAcceptanceRefusedError);
    expect(harness.journal.events().filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toMatchObject({ kind: 'active' });
    expect(harness.deps.abortRegistry.has(launchRecord.jobId, 1)).toBe(true);
  });

  it('records artifact evidence and continuity in the outcome acceptance transaction before releasing ownership', async () => {
    const harness = createHarness();
    await finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps);
    await harness.finish();
    expect(harness.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'job.artifact.recorded',
        body: expect.objectContaining({
          execution: 1,
          handle: '/provider/thread-recovered.jsonl',
          identity: { kind: 'fixture', threadId: 'thread-recovered' },
        }),
      }),
    );
    expect(harness.order).toEqual([
      'job.artifact.recorded',
      'job.continuity.checkpointed',
      'job.execution.outcome.accepted',
      'abort-remove',
      'admission-release',
      'job.execution.ended',
    ]);
    expect(harness.launchPermit.reservationId).not.toBe('');
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toBeNull();
  });

  it('does not persist a durable outcome or release ownership while the exact execution is unavailable', async () => {
    const harness = createHarness({ sessionFinalized: false });
    const pending = finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps);
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toMatchObject({ kind: 'active' });
    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
    await harness.repairWrites();
    await pending;
    await harness.finish();
    expect(harness.store.readStatus(launchRecord.jobId)?.phase).toBe('completed');
  });

  it('keeps artifact evidence and terminal acceptance pending together across an artifact write failure', async () => {
    const harness = createHarness({ artifactRecorded: false });
    const pending = finalizeInterruptedDurableRecovery(durablePlan, durablePerformed, status, harness.deps);
    await Promise.resolve();
    expect(harness.readById).toHaveBeenCalled();
    expect(harness.append).not.toHaveBeenCalled();
    expect(harness.launchCoordinator.reservationFor(launchRecord.jobId)).toMatchObject({ kind: 'active' });
    expect(harness.releaseLaunch).not.toHaveBeenCalled();
    await harness.repairWrites();
    await pending;
    await harness.finish();
    expect(harness.journal.events().filter((event) => event.type === 'job.artifact.recorded')).toHaveLength(1);
  });
});

it.each(
  (['before-commit', 'after-accept', 'after-finalizer'] as const).flatMap((stage) =>
    (['populated', 'missing', 'unknown'] as const).map((kind) => ({ stage, kind })),
  ),
)(
  'retains detached carrier ownership when its leaf becomes $kind $stage until recovery retries',
  async ({ stage, kind }) => {
    const h = createHarness({ requireOperationRelease: true });
    try {
      const provider = createRecoveryProvider();
      const base = providerOperationRecord('executing');
      const record = providerOperationRecord('executing', {
        operation: { ...base.operation, jobId: launchRecord.jobId },
      }) as ProviderOperationCarrierRecord;
      insertProviderOperation(h.journal.db, record);
      let observation: FailureDomainObservation = { kind: 'absent' };
      vi.spyOn(h.deps.runtime.env, 'platform').mockReturnValue('linux');
      vi.spyOn(h.deps.runtime.process, 'failureDomainContainment').mockReturnValue({
        observe: () => observation,
        kill: () => ({ kind: 'refused', errno: 'EACCES' }),
      });
      Object.defineProperty(h.deps.runtime.process, 'observeRecordedProcessAsync', {
        value: vi.fn(async () => 'absent' as const),
      });
      const service = new RecoveryService({
        runtime: h.deps.runtime,
        executionFinisher: h.deps.executionFinisher,
        conversationManager: h.deps.conversationManager,
        abortRegistry: h.deps.abortRegistry,
        progressStore: h.store,
        launchAdmission: h.deps.launchAdmission,
        backendNamespace: 'namespace',
        bundleHash: 'bundle',
        launchRecovery: {} as never,
        providerRegistry: {} as never,
        launchOrchestrator: {} as never,
        childPrincipalRegistry: {} as never,
        parentPrincipal: {} as never,
      });
      const authority = {
        launchRecord,
        session: recoveredSession,
        boundProvider: provider.boundProvider,
      } as ProviderRecoveryAuthority;
      const changeLeaf = () => {
        observation = kind === 'unknown' ? { kind, reason: 'EACCES' } : { kind };
      };
      if (stage === 'after-accept')
        h.append.mockImplementation((event) => {
          if (event.type === 'job.execution.outcome.accepted') changeLeaf();
        });
      let first = true;
      let restoreRemoval: (() => void) | undefined;
      if (stage === 'after-finalizer') {
        const remove = h.remove.getMockImplementation();
        if (remove === undefined) throw new Error('fixture removal implementation missing');
        restoreRemoval = () => {
          h.remove.mockImplementation(remove);
        };
        h.remove.mockImplementation((jobId, execution) => {
          remove(jobId, execution);
          if (observation.kind === 'absent') queueMicrotask(changeLeaf);
        });
      }
      await expect(
        service.finalizeInterruptedAppServerJob(authority, plan.runtimeRecord, {
          reason: 'restart',
          signal: new AbortController().signal,
          onCommitStart: () => {
            if (stage === 'before-commit' && first) {
              first = false;
              queueMicrotask(changeLeaf);
            }
          },
        }),
      ).rejects.toBeInstanceOf(stage === 'after-finalizer' ? ProcessContainmentError : ExecutionAcceptanceRefusedError);
      expect(readProviderOperation(h.journal.db, record.operation)).toEqual(record);
      expect(h.deps.abortRegistry.has(launchRecord.jobId, 1)).toBe(stage !== 'after-finalizer');
      expect(h.launchCoordinator.reservationFor(launchRecord.jobId)).not.toBeNull();
      expect(h.append.mock.calls.some(([event]) => event.type === 'job.execution.outcome.accepted')).toBe(
        stage !== 'before-commit',
      );
      if (kind === 'missing') {
        await expect(
          service.finalizeInterruptedAppServerJob(authority, plan.runtimeRecord, {
            reason: 'restart',
            signal: new AbortController().signal,
            onCommitStart: () => {},
          }),
        ).rejects.toMatchObject({ code: 'process_containment_reap_failed' });
        expect(readProviderOperation(h.journal.db, record.operation)).toEqual(record);
        expect(h.deps.abortRegistry.has(launchRecord.jobId, 1)).toBe(stage !== 'after-finalizer');
      }
      observation = { kind: 'absent' };
      restoreRemoval?.();
      h.append.mockImplementation(() => {});
      await service.finalizeInterruptedAppServerJob(authority, plan.runtimeRecord, {
        reason: 'restart',
        signal: new AbortController().signal,
        onCommitStart: () => {},
      });
      expect(readProviderOperation(h.journal.db, record.operation)).toBeNull();
      expect(h.deps.abortRegistry.has(launchRecord.jobId, 1)).toBe(false);
      const released = h.deps.launchAdmission.releaseLaunch(h.launchPermit);
      expect(released.kind).toBe('released');
      await h.finish();
      expect(readExecutionFinishingState(h.journal.db, launchRecord, h.store).kind).toBe('ended');
    } finally {
      await h.deps.executionFinisher.dispose();
    }
  },
);

it('does not reclaim a healthy carrier set while finalizing an acknowledged user abort', async () => {
  const h = createHarness({ requireOperationRelease: true });
  const provider = createRecoveryProvider();
  const base = providerOperationRecord('executing');
  const record = providerOperationRecord('executing', {
    operation: { ...base.operation, jobId: launchRecord.jobId },
  }) as ProviderOperationCarrierRecord;
  insertProviderOperation(h.journal.db, record);
  const kill = vi.fn(() => ({ kind: 'refused' as const, errno: 'EPERM' }));
  vi.spyOn(h.deps.runtime.process, 'failureDomainContainment').mockReturnValue({
    observe: () => ({ kind: 'populated' }),
    kill,
  });
  const numericKill = vi.spyOn(h.deps.runtime.process, 'kill');
  const service = new RecoveryService({
    runtime: h.deps.runtime,
    executionFinisher: h.deps.executionFinisher,
    conversationManager: h.deps.conversationManager,
    abortRegistry: h.deps.abortRegistry,
    progressStore: h.store,
    launchAdmission: h.deps.launchAdmission,
    backendNamespace: 'namespace',
    bundleHash: 'bundle',
    launchRecovery: {} as never,
    providerRegistry: {} as never,
    launchOrchestrator: {} as never,
    childPrincipalRegistry: {} as never,
    parentPrincipal: {} as never,
  });
  await service.finalizeInterruptedAppServerJob(
    { launchRecord, session: recoveredSession, boundProvider: provider.boundProvider } as ProviderRecoveryAuthority,
    plan.runtimeRecord,
    { reason: 'user_abort', signal: new AbortController().signal, onCommitStart: () => {} },
  );
  expect(kill).not.toHaveBeenCalled();
  expect(numericKill).not.toHaveBeenCalled();
  expect(readProviderOperation(h.journal.db, record.operation)).toEqual(record);
  await h.deps.executionFinisher.dispose();
});

it('retains the carrier row and retry authority after transient operation retirement failure', async () => {
  const h = createHarness({ requireOperationRelease: true });
  const provider = createRecoveryProvider();
  const base = providerOperationRecord('executing');
  const record = providerOperationRecord('executing', {
    operation: { ...base.operation, jobId: launchRecord.jobId },
  }) as ProviderOperationCarrierRecord;
  insertProviderOperation(h.journal.db, record);
  vi.spyOn(h.deps.runtime.env, 'platform').mockReturnValue('linux');
  vi.spyOn(h.deps.runtime.process, 'failureDomainContainment').mockReturnValue({
    observe: () => ({ kind: 'absent' }),
    kill: () => ({ kind: 'entered' }),
  });
  Object.defineProperty(h.deps.runtime.process, 'observeRecordedProcessAsync', { value: async () => 'absent' });
  h.journal.db.exec(
    "CREATE TEMP TRIGGER carrier_retirement_failure BEFORE DELETE ON meta WHEN OLD.key LIKE 'provider_operation_saga.%' BEGIN SELECT RAISE(ABORT, 'temporary carrier retirement failure'); END",
  );
  const service = new RecoveryService({
    runtime: h.deps.runtime,
    executionFinisher: h.deps.executionFinisher,
    conversationManager: h.deps.conversationManager,
    abortRegistry: h.deps.abortRegistry,
    progressStore: h.store,
    launchAdmission: h.deps.launchAdmission,
    backendNamespace: 'namespace',
    bundleHash: 'bundle',
    launchRecovery: {} as never,
    providerRegistry: {} as never,
    launchOrchestrator: {} as never,
    childPrincipalRegistry: {} as never,
    parentPrincipal: {} as never,
  });
  const authority = {
    launchRecord,
    session: recoveredSession,
    boundProvider: provider.boundProvider,
  } as ProviderRecoveryAuthority;
  const options = { reason: 'restart' as const, signal: new AbortController().signal, onCommitStart: () => {} };
  try {
    await expect(service.finalizeInterruptedAppServerJob(authority, plan.runtimeRecord, options)).rejects.toMatchObject(
      { code: 'process_containment_reap_failed' },
    );
    expect(readProviderOperation(h.journal.db, record.operation)).toEqual(record);
    expect(h.launchCoordinator.reservationFor(launchRecord.jobId)).not.toBeNull();
    h.journal.db.exec('DROP TRIGGER carrier_retirement_failure');
    await service.finalizeInterruptedAppServerJob(authority, plan.runtimeRecord, options);
    expect(readProviderOperation(h.journal.db, record.operation)).toBeNull();
    expect(h.deps.launchAdmission.releaseLaunch(h.launchPermit).kind).toBe('released');
    await h.finish();
    expect(readExecutionFinishingState(h.journal.db, launchRecord, h.store).kind).toBe('ended');
  } finally {
    await h.deps.executionFinisher.dispose();
  }
});
