import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { ControllerTransferOutcome } from '#src/coordinator/live/provider-proxy/set-authority.js';
import {
  decodeProviderProxyControllerTransfer,
  type ProviderProxyControllerTransfer,
} from '#src/coordinator/services/provider-proxy-set/controller-transfer.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { classifyProviderProxySetInheritance } from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import type { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import type { SuccessionCapabilities } from '#src/coordinator/succession/protocol.js';
import {
  acceptedControllerTransferHandsCapsule,
  createProviderHostTransfer,
  providerHostRecoveryGrantVerifies,
  servedControllerTransferForCapsule,
} from '#src/coordinator/succession/provider-host-transfer.js';
import {
  currentHandoffCapsulePath,
  writeHandoffCapsuleFile,
  type HandoffCapsuleV4,
} from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import type { ProviderOperationPhase, ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { successionPreparationSchema, type SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { controllerBuild } from '#src/coordinator-launch/controller-build.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import type * as WriterGeneration from '#src/store/succession-writer-generation.js';

const serving = vi.hoisted(() => ({ attemptId: null as string | null }));

vi.mock('#src/store/succession-writer-generation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof WriterGeneration>()),
  observeSuccessionServing: (_runtime: unknown, attemptId: string) =>
    serving.attemptId === attemptId
      ? { attemptId, epochKey: 'epoch', successorInstanceId: 'successor', controlGeneration: 2, recordedAt: '' }
      : null,
}));

const INCUMBENT_BUILD = '11111111-1111-4111-8111-111111111111';
const SUCCESSOR_BUILD = '22222222-2222-4222-8222-222222222222';
const HOST_BUILD = '00000000-0000-4000-8000-000000000004';
const RECOVERY_GRANT = '33333333-3333-4333-8333-333333333333';

const roots: string[] = [];
afterEach(() => {
  serving.attemptId = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function seedPreparation(runtime: Runtime, receipts: SuccessionPreparation['receipts']): Promise<void> {
  const preparation: SuccessionPreparation = {
    version: 'v1',
    requestId: 'request-1',
    attemptId: 'attempt-1',
    incumbentInstanceId: 'incumbent',
    incumbentPid: 1,
    incumbentKey: 'incumbent-key',
    targetKey: 'target-key',
    capabilitiesKey: 'capabilities-key',
    epochKey: 'epoch-key',
    admissionRevision: 0,
    accepts: ACCEPTS_HOSTS.accepts,
    receipts,
    stage: 'prepared',
    ready: null,
  };
  const written = await compareAndSwapUpgradeIntent(runtime.paths.coral.coordinator.runDir, null, {
    requestId: 'request-1',
    incumbent: {
      instanceId: 'incumbent',
      pid: 1,
      incarnation: null,
      version: '0.0.1',
      bundleHash: 'fedcba9876543210',
      flavor: 'prod',
    },
    target: {
      build: {
        version: '0.11.0',
        buildSetId: SUCCESSOR_BUILD,
        flavor: 'prod',
        storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
        bundleHash: '0123456789abcdef',
        cliBundleHash: '0123456789abcdef',
        claudeAppserverBundleHash: '0123456789abcdef',
        durableWrapperBundleHash: '0123456789abcdef',
      },
      pluginRootLabel: '/installed/coral/0.11.0',
    },
    attemptId: 'attempt-1',
    attemptOwner: { kind: 'incumbent', instanceId: 'incumbent', pid: 1, incarnation: null },
    attemptChild: null,
    disposition: 'pending',
    blockers: [],
    retryCondition: null,
    attemptDeadline: null,
    completionReceipt: null,
    successionPreparation: preparation,
  });
  if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
}

function capabilities(accepts: SuccessionCapabilities['accepts']): SuccessionCapabilities {
  return { version: 'v1', buildSetId: SUCCESSOR_BUILD, bundleHash: 'hash', protocols: ['prepare', 'commit'], accepts };
}

const ACCEPTS_HOSTS = capabilities([
  { owner: 'provider-proxy-sets', generation: 1 },
  { owner: 'provider-operations', generation: 1 },
]);

function runtimeFor(): Runtime {
  const root = mkdtempSync(join(tmpdir(), 'coral-host-transfer-unit-'));
  roots.push(root);
  return createRealRuntime('prod', { baseDir: join(root, '.coral') });
}

function databaseWith(records: readonly ProviderOperationRecord[]): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  for (const record of records) insertProviderOperation(db, record);
  return db;
}

function hostFor(
  record: ProviderOperationRecord,
  transfer: (attemptId: string) => Promise<ControllerTransferOutcome>,
): DurableProviderProxyOperationAuthority {
  return {
    setIdentity: providerProxySetIdentityFromRecord(record),
    authorizeControllerTransfer: vi.fn(({ attemptId }: { attemptId: string }) => transfer(attemptId)),
    installRecoveryCredential: vi.fn(),
  } as unknown as DurableProviderProxyOperationAuthority;
}

function lifecycleWith(hosts: readonly DurableProviderProxyOperationAuthority[]): ProviderProxySetLifecycle {
  return {
    liveSets: () => hosts,
    authorityFor: (identity: { proxyInstanceId: string }) =>
      hosts.find((host) => host.setIdentity.proxyInstanceId === identity.proxyInstanceId) ?? null,
    releaseControlForTransfer: vi.fn(async () => []),
    reclaimTransferredControl: vi.fn(),
  } as unknown as ProviderProxySetLifecycle;
}

function transferFor(
  runtime: Runtime,
  options: Readonly<{
    db?: Database;
    hosts?: readonly DurableProviderProxyOperationAuthority[];
    retained?: boolean;
    localOperationJobIds?: readonly string[];
    formatChanges?: boolean;
  }> = {},
) {
  const db = options.db ?? databaseWith([]);
  return createProviderHostTransfer({
    runtime,
    flavor: 'prod',
    buildSetId: INCUMBENT_BUILD,
    lifecycle: () => lifecycleWith(options.hosts ?? []),
    db: () => db,
    jobSettled: () => false,
    localOperationJobIds: () => options.localOperationJobIds ?? [],
    hostRootRetained: () => options.retained ?? true,
    attemptId: () => null,
    targetChangesStoreFormat: () => options.formatChanges ?? false,
    log: () => undefined,
  });
}

async function classify(
  transfer: ReturnType<typeof createProviderHostTransfer>,
  accepted: SuccessionCapabilities = ACCEPTS_HOSTS,
) {
  const [operations, sets] = transfer.owners;
  return {
    operations: await operations.classify('attempt-1', accepted),
    sets: await sets.classify('attempt-1', accepted),
  };
}

const authorized = async (): Promise<ControllerTransferOutcome> => ({
  kind: 'authorized',
  recoveryGrantId: RECOVERY_GRANT,
});

function executing(phase: ProviderOperationPhase = 'executing'): ProviderOperationRecord {
  return providerOperationRecord(phase);
}

describe('provider host transfer owners', () => {
  it('transfers every host and its operations under the recovery grant each host holds', async () => {
    const record = executing();
    const host = hostFor(record, authorized);
    const result = await classify(transferFor(runtimeFor(), { db: databaseWith([record]), hosts: [host] }));

    expect(host.authorizeControllerTransfer).toHaveBeenCalledWith(
      { attemptId: 'attempt-1', successor: { generation: 'gen2', flavor: 'prod', buildSetId: SUCCESSOR_BUILD } },
      expect.any(AbortSignal),
    );
    expect(result.operations).toMatchObject({ kind: 'transferable', jobIds: [record.operation.jobId] });
    expect(result.sets).toMatchObject({ kind: 'transferable' });
    if (result.sets.kind !== 'transferable') throw new Error('expected a host receipt');
    const payload = decodeProviderProxyControllerTransfer(result.sets.receipt.payload);
    expect(payload).toMatchObject({
      incumbentBuildSetId: INCUMBENT_BUILD,
      successorBuildSetId: SUCCESSOR_BUILD,
      sets: [{ proxyInstanceId: record.operation.proxyInstanceId, recoveryGrantId: RECOVERY_GRANT }],
    });
    // One receipt claims the jobs; the other names the hosts, and both carry the same recovery grant.
    expect('jobIds' in result.sets ? result.sets.jobIds : undefined).toBeUndefined();
    if (result.operations.kind !== 'transferable') throw new Error('expected an operation receipt');
    expect(result.operations.receipt.recoveryGrantId).toBe(result.sets.receipt.recoveryGrantId);
  });

  describe.each([
    [
      'a successor that does not accept this host control generation',
      () => ({ accepted: capabilities([{ owner: 'provider-operations', generation: 1 }]) }),
      /host control generation 1/u,
    ],
    [
      'a legacy host that does not serve controller transfer',
      () => ({ outcome: async (): Promise<ControllerTransferOutcome> => ({ kind: 'legacy-host', role: 'guardian' }) }),
      /predates controller succession/u,
    ],
    ['a host that does not run from a retained plugin root', () => ({ retained: false }), /not retained/u],
    ['an operation still being published', () => ({ phase: 'prepare-pending' as const }), /is prepare-pending/u],
    ['a successor that changes the store format', () => ({ formatChanges: true }), /changes the store format/u],
    [
      'an in-process operation with no durable saga record',
      () => ({ localOperationJobIds: ['99999999-9999-4999-8999-999999999999'] }),
      /without a durable saga record/u,
    ],
  ] as const)('blocks %s', (_case, setup, reason) => {
    it('answers blocking from both owners', async () => {
      const options = setup() as Readonly<{
        accepted?: SuccessionCapabilities;
        outcome?: () => Promise<ControllerTransferOutcome>;
        retained?: boolean;
        phase?: ProviderOperationPhase;
        localOperationJobIds?: readonly string[];
        formatChanges?: boolean;
      }>;
      const record = executing(options.phase ?? 'executing');
      const host = hostFor(record, options.outcome ?? authorized);
      const transfer = transferFor(runtimeFor(), {
        db: databaseWith([record]),
        hosts: [host],
        ...(options.retained === undefined ? {} : { retained: options.retained }),
        ...(options.localOperationJobIds === undefined ? {} : { localOperationJobIds: options.localOperationJobIds }),
        ...(options.formatChanges === undefined ? {} : { formatChanges: options.formatChanges }),
      });

      const authorize = host.authorizeControllerTransfer as ReturnType<typeof vi.fn>;

      const result = await classify(transfer, options.accepted ?? ACCEPTS_HOSTS);

      expect(result.operations).toMatchObject({ kind: 'blocking', reason: expect.stringMatching(reason) });
      expect(result.sets).toMatchObject({ kind: 'blocking', reason: expect.stringMatching(reason) });
      if (options.outcome === undefined) {
        expect(authorize, 'a blocked transfer must not authorize any host').not.toHaveBeenCalled();
      }
    });
  });
});

describe('accepted controller transfer', () => {
  it.each([false, true])('selects the served controller before capsule completion (mixed sets: %s)', async (mixed) => {
    const runtime = runtimeFor();
    const capsule = capsuleFor(runtime, INCUMBENT_BUILD);
    await preparedTransfer(runtime);
    const incarnation = probeProcessIncarnation(process.pid);
    if (incarnation === null) throw new Error('Test process has no incarnation');
    const live = { ...capsule, proxyPid: process.pid, proxyIncarnation: incarnation };
    const pathOptions = { baseDir: dirname(runtime.paths.coral.generation.root) };
    const writeLive = (entry: HandoffCapsuleV4): void => {
      writeHandoffCapsuleFile(currentHandoffCapsulePath(entry, pathOptions), entry, {
        storage: runtime.storage,
        uid: process.getuid?.() ?? 0,
      });
    };
    writeLive(live);
    if (mixed)
      writeLive({
        ...live,
        proxyInstanceId: '66666666-6666-4666-8666-666666666666',
        hostFingerprint: 'f'.repeat(64),
        controllerBuildSetId: SUCCESSOR_BUILD,
      });
    serving.attemptId = 'attempt-1';
    expect(controllerBuild(runtime.paths.coral.coordinator.runDir)).toEqual({
      kind: 'required',
      buildSetId: SUCCESSOR_BUILD,
    });
  });

  function capsuleFor(runtime: Runtime, controllerBuildSetId: string): HandoffCapsuleV4 {
    const record = executing();
    const identity = providerProxySetIdentityFromRecord(record);
    const capsule: HandoffCapsuleV4 = {
      version: 4,
      controllerBuildSetId,
      grantId: RECOVERY_GRANT,
      secret: 'e'.repeat(64),
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: identity.buildSetId,
      hostFingerprint: identity.hostFingerprint,
      guardianInstanceId: identity.guardianInstanceId,
      reaperInstanceId: identity.reaperInstanceId,
      proxyInstanceId: identity.proxyInstanceId,
      guardianControlEndpoint: identity.guardianControlEndpoint,
      reaperControlEndpoint: identity.reaperControlEndpoint,
      proxyEndpoint: identity.canonicalEndpoint,
      orphanTimeoutMs: 30_000,
      teardownReserveMs: 14_000,
      guardianPid: identity.guardianPid,
      guardianIncarnation: identity.guardianIncarnation,
      proxyPid: identity.proxyPid,
      reaperPid: identity.reaperPid,
      reaperIncarnation: identity.reaperIncarnation,
      containmentKind: identity.containmentKind,
      proxyIncarnation: identity.proxyIncarnation,
      proxyProcessGroupId: identity.proxyProcessGroupId,
    };
    runtime.storage.mkdirSync(runtime.paths.coral.coordinator.runDir, { recursive: true, mode: 0o700 });
    writeHandoffCapsuleFile(
      currentHandoffCapsulePath(
        {
          generation: 'gen2',
          flavor: 'prod',
          buildSetId: HOST_BUILD,
          hostFingerprint: identity.hostFingerprint,
          proxyInstanceId: identity.proxyInstanceId,
        },
        { baseDir: dirname(runtime.paths.coral.generation.root) },
      ),
      capsule,
      { storage: runtime.storage, uid: process.getuid?.() ?? 0 },
    );
    return capsule;
  }

  async function preparedTransfer(
    runtime: Runtime,
  ): Promise<Readonly<{ attemptId: string; transfer: ProviderProxyControllerTransfer }>> {
    const record = executing();
    const result = await classify(
      transferFor(runtime, { db: databaseWith([record]), hosts: [hostFor(record, authorized)] }),
    );
    if (result.sets.kind !== 'transferable' || result.operations.kind !== 'transferable') {
      throw new Error('expected host receipts');
    }
    await seedPreparation(runtime, [result.operations.receipt, result.sets.receipt]);
    const transfer = decodeProviderProxyControllerTransfer(result.sets.receipt.payload);
    if (transfer === null) throw new Error('expected a decodable host receipt');
    return { attemptId: 'attempt-1', transfer };
  }

  it('hands a set only to the attempt that runs as its successor until serving is recorded', async () => {
    const runtime = runtimeFor();
    const capsule = capsuleFor(runtime, INCUMBENT_BUILD);
    await preparedTransfer(runtime);

    expect(acceptedControllerTransferHandsCapsule(runtime, SUCCESSOR_BUILD, 'attempt-1', capsule)).toBe(
      'before-serving',
    );
    expect(acceptedControllerTransferHandsCapsule(runtime, SUCCESSOR_BUILD, 'another-attempt', capsule)).toBe(
      'not-accepted',
    );
    expect(acceptedControllerTransferHandsCapsule(runtime, INCUMBENT_BUILD, 'attempt-1', capsule)).toBe('not-accepted');
    // A capsule a later controller already took over is not the receipt's to hand on again.
    expect(
      acceptedControllerTransferHandsCapsule(runtime, SUCCESSOR_BUILD, 'attempt-1', {
        ...capsule,
        controllerBuildSetId: SUCCESSOR_BUILD,
      }),
    ).toBe('not-accepted');

    serving.attemptId = 'attempt-1';
    expect(acceptedControllerTransferHandsCapsule(runtime, SUCCESSOR_BUILD, null, capsule)).toBe('served');
  });

  it('keeps a refused host grant redeemable after preparation clears and the successor restarts', async () => {
    const runtime = runtimeFor();
    const capsule = capsuleFor(runtime, INCUMBENT_BUILD);
    await preparedTransfer(runtime);

    expect(acceptedControllerTransferHandsCapsule(runtime, SUCCESSOR_BUILD, 'attempt-1', capsule)).toBe(
      'before-serving',
    );
    const record = executing();
    const host = hostFor(record, authorized);
    const install = host.installRecoveryCredential as ReturnType<typeof vi.fn>;
    install.mockResolvedValueOnce({ kind: 'refused', incident: { role: 'guardian' } }).mockResolvedValue({
      kind: 'installed',
      receipt: { kind: 'installed-recovery-credential', grantId: RECOVERY_GRANT },
    });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const completing = transferFor(
      { ...runtime, time: { ...runtime.time, sleep: () => paused } },
      { hosts: [host] },
    ).completeTransfers();
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));

    serving.attemptId = 'attempt-1';
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('expected a readable intent');
    const cleared = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      observed.intent.revision,
      {
        ...observed.intent,
        successionPreparation: null,
      },
    );
    expect(cleared.kind).toBe('written');

    const acceptance = acceptedControllerTransferHandsCapsule(runtime, SUCCESSOR_BUILD, null, capsule);
    expect(servedControllerTransferForCapsule(runtime, capsule)).toEqual({
      kind: 'served',
      buildSetId: SUCCESSOR_BUILD,
    });
    expect(classifyProviderProxySetInheritance(capsule, SUCCESSOR_BUILD, () => acceptance)).toMatchObject({
      kind: 'inheritable',
      via: 'transfer-served',
    });
    resume();
    await completing;
  });

  it('accepts the completed host receipt after the old serving marker is cleared', async () => {
    const runtime = runtimeFor();
    const capsule = capsuleFor(runtime, INCUMBENT_BUILD);
    await preparedTransfer(runtime);
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('expected a readable intent');
    const preparation = successionPreparationSchema.parse(observed.intent.successionPreparation);
    const setsReceipt = preparation.receipts.find((receipt) => receipt.owner === 'provider-proxy-sets');
    if (setsReceipt === undefined) throw new Error('expected the host receipt');
    const completed = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      observed.intent.revision,
      {
        ...observed.intent,
        disposition: 'completed',
        completionReceipt: {
          kind: 'serving',
          attemptId: preparation.attemptId,
          successor: {
            instanceId: 'successor',
            pid: 2,
            incarnation: null,
            build: observed.intent.target.build,
          },
          epochKey: preparation.epochKey,
          controlGeneration: 2,
          acceptedObligations: [
            { owner: 'provider-proxy-sets', receiptId: setsReceipt.receiptId, controlGeneration: 2 },
          ],
          recordedAt: new Date().toISOString(),
        },
      },
    );
    expect(completed.kind).toBe('written');

    expect(acceptedControllerTransferHandsCapsule(runtime, SUCCESSOR_BUILD, null, capsule)).toBe('served');
    expect(acceptedControllerTransferHandsCapsule(runtime, INCUMBENT_BUILD, null, capsule)).toBe('not-accepted');
    const servingIntent = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (servingIntent.kind !== 'readable' || servingIntent.intent.completionReceipt === null) {
      throw new Error('expected a completed intent');
    }
    const changed = await compareAndSwapUpgradeIntent(
      runtime.paths.coral.coordinator.runDir,
      servingIntent.intent.revision,
      {
        ...servingIntent.intent,
        completionReceipt: {
          ...servingIntent.intent.completionReceipt,
          acceptedObligations: [],
        },
      },
    );
    expect(changed.kind).toBe('written');
    expect(acceptedControllerTransferHandsCapsule(runtime, SUCCESSOR_BUILD, null, capsule)).toBe('not-accepted');
  });

  it('holds an accepted host when its restart evidence cannot be written durably', async () => {
    const runtime = runtimeFor();
    const capsule = capsuleFor(runtime, INCUMBENT_BUILD);
    await preparedTransfer(runtime);
    const unwritable = {
      ...runtime,
      storage: { ...runtime.storage, writeAtomicDurableSync: () => false },
    } as Runtime;

    const acceptance = acceptedControllerTransferHandsCapsule(unwritable, SUCCESSOR_BUILD, 'attempt-1', capsule);
    expect(acceptance).toBe('unconfirmed');
    expect(classifyProviderProxySetInheritance(capsule, SUCCESSOR_BUILD, () => acceptance)).toMatchObject({
      kind: 'held',
      reason: 'transfer-status-unconfirmed',
    });
  });

  it('verifies the recovery grant a failed attempt redeems only while the capsule still holds it', async () => {
    const runtime = runtimeFor();
    capsuleFor(runtime, INCUMBENT_BUILD);
    const { transfer } = await preparedTransfer(runtime);
    const intentReceipts = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (intentReceipts.kind !== 'readable') throw new Error('expected a readable intent');
    const preparation = successionPreparationSchema.parse(intentReceipts.intent.successionPreparation);
    for (const receipt of preparation.receipts) {
      expect(providerHostRecoveryGrantVerifies(runtime, 'prod', preparation, receipt)).toBe(true);
    }

    capsuleFor(runtime, SUCCESSOR_BUILD);
    const setsReceipt = preparation.receipts.find((receipt) => receipt.owner === 'provider-proxy-sets');
    if (setsReceipt === undefined) throw new Error('expected the host receipt');
    expect(providerHostRecoveryGrantVerifies(runtime, 'prod', preparation, setsReceipt)).toBe(false);
    expect(transfer.sets).toHaveLength(1);
  });
});

describe('provider host transfer across a failed attempt', () => {
  async function preparedIntent(runtime: Runtime, controller: string): Promise<SuccessionPreparation> {
    const record = executing();
    const result = await classify(
      transferFor(runtime, { db: databaseWith([record]), hosts: [hostFor(record, authorized)] }),
    );
    if (result.sets.kind !== 'transferable' || result.operations.kind !== 'transferable') {
      throw new Error('expected host receipts');
    }
    await seedPreparation(runtime, [result.operations.receipt, result.sets.receipt]);
    return successionPreparationFrom(runtime, controller);
  }

  function successionPreparationFrom(runtime: Runtime, controller: string): SuccessionPreparation {
    writeCapsule(runtime, controller);
    const observed = readUpgradeIntent(runtime.paths.coral.coordinator.runDir);
    if (observed.kind !== 'readable') throw new Error('expected a readable intent');
    return successionPreparationSchema.parse(observed.intent.successionPreparation);
  }

  function writeCapsule(runtime: Runtime, controllerBuildSetId: string): void {
    const identity = providerProxySetIdentityFromRecord(executing());
    runtime.storage.mkdirSync(runtime.paths.coral.coordinator.runDir, { recursive: true, mode: 0o700 });
    writeHandoffCapsuleFile(
      currentHandoffCapsulePath(
        {
          generation: 'gen2',
          flavor: 'prod',
          buildSetId: identity.buildSetId,
          hostFingerprint: identity.hostFingerprint,
          proxyInstanceId: identity.proxyInstanceId,
        },
        { baseDir: dirname(runtime.paths.coral.generation.root) },
      ),
      {
        version: 4,
        controllerBuildSetId,
        grantId: RECOVERY_GRANT,
        secret: 'e'.repeat(64),
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: identity.buildSetId,
        hostFingerprint: identity.hostFingerprint,
        guardianInstanceId: identity.guardianInstanceId,
        reaperInstanceId: identity.reaperInstanceId,
        proxyInstanceId: identity.proxyInstanceId,
        guardianControlEndpoint: identity.guardianControlEndpoint,
        reaperControlEndpoint: identity.reaperControlEndpoint,
        proxyEndpoint: identity.canonicalEndpoint,
        orphanTimeoutMs: 30_000,
        teardownReserveMs: 14_000,
        guardianPid: identity.guardianPid,
        guardianIncarnation: identity.guardianIncarnation,
        proxyPid: identity.proxyPid,
        reaperPid: identity.reaperPid,
        reaperIncarnation: identity.reaperIncarnation,
        containmentKind: identity.containmentKind,
        proxyIncarnation: identity.proxyIncarnation,
        proxyProcessGroupId: identity.proxyProcessGroupId,
      },
      { storage: runtime.storage, uid: process.getuid?.() ?? 0 },
    );
  }

  function readerOf(runtime: Runtime, buildSetId: string) {
    const db = databaseWith([executing()]);
    return createProviderHostTransfer({
      runtime,
      flavor: 'prod',
      buildSetId,
      lifecycle: () => lifecycleWith([]),
      db: () => db,
      jobSettled: () => false,
      localOperationJobIds: () => [],
      hostRootRetained: () => true,
      attemptId: () => null,
      targetChangesStoreFormat: () => false,
      log: () => undefined,
    });
  }

  it("lets a same-build recovery child verify the receipt through the grant its incumbent's build still holds", async () => {
    const runtime = runtimeFor();
    const preparation = await preparedIntent(runtime, INCUMBENT_BUILD);

    expect(readerOf(runtime, INCUMBENT_BUILD).verifyReceipts(preparation)).toEqual([executing().operation.jobId]);
    expect(() => readerOf(runtime, '55555555-5555-4555-8555-555555555555').verifyReceipts(preparation)).toThrow(
      /does not name this successor/u,
    );
  });

  it('refuses a recovery child once the capsule no longer holds the grant under its own build', async () => {
    const runtime = runtimeFor();
    const preparation = await preparedIntent(runtime, SUCCESSOR_BUILD);

    expect(() => readerOf(runtime, INCUMBENT_BUILD).verifyReceipts(preparation)).toThrow(
      /recovery grants are unavailable/u,
    );
  });

  it('accepts a committed successor receipt after its provider operation settled', async () => {
    const runtime = runtimeFor();
    const preparation = await preparedIntent(runtime, SUCCESSOR_BUILD);
    const reader = (settled: boolean) =>
      createProviderHostTransfer({
        runtime,
        flavor: 'prod',
        buildSetId: SUCCESSOR_BUILD,
        lifecycle: () => lifecycleWith([]),
        db: () => databaseWith([]),
        jobSettled: () => settled,
        localOperationJobIds: () => [],
        hostRootRetained: () => true,
        attemptId: () => null,
        targetChangesStoreFormat: () => false,
        log: () => undefined,
      });

    expect(reader(true).verifyReceipts(preparation, true)).toEqual([]);
    expect(() => reader(false).verifyReceipts(preparation, true)).toThrow(/no longer matches/u);
  });

  it('does not retain a settled operation behind a vanished transfer host during committed recovery', async () => {
    const runtime = runtimeFor();
    const preparation = await preparedIntent(runtime, SUCCESSOR_BUILD);
    let jobSettled = true;
    const settledRecovery = createProviderHostTransfer({
      runtime,
      flavor: 'prod',
      buildSetId: SUCCESSOR_BUILD,
      lifecycle: () => lifecycleWith([]),
      db: () => databaseWith([]),
      jobSettled: () => jobSettled,
      localOperationJobIds: () => [],
      hostRootRetained: () => true,
      attemptId: () => null,
      targetChangesStoreFormat: () => false,
      log: () => undefined,
    });

    expect(settledRecovery.verifyReceipts(preparation, true)).toEqual([]);
    const identity = providerProxySetIdentityFromRecord(executing());
    const capsulePath = currentHandoffCapsulePath(
      {
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: identity.buildSetId,
        hostFingerprint: identity.hostFingerprint,
        proxyInstanceId: identity.proxyInstanceId,
      },
      { baseDir: dirname(runtime.paths.coral.generation.root) },
    );
    runtime.storage.unlinkSync(capsulePath);
    expect(settledRecovery.verifyReceipts(preparation, true)).toEqual([]);
    jobSettled = false;
    expect(() => settledRecovery.verifyReceipts(preparation, true)).toThrow(/recovery grants are unavailable/u);
  });
});

describe('provider host transfer at the commit and after serving', () => {
  const INSTALLED = {
    kind: 'installed',
    receipt: { kind: 'installed-recovery-credential', grantId: RECOVERY_GRANT },
  } as const;
  const RETRYABLE = { kind: 'retryable', incident: { role: 'guardian' } } as const;

  function transferOver(
    runtime: Runtime,
    lifecycle: ProviderProxySetLifecycle,
    record: ProviderOperationRecord,
    log: (message: string) => void = () => undefined,
  ) {
    const db = databaseWith([record]);
    return createProviderHostTransfer({
      runtime: { ...runtime, time: { ...runtime.time, sleep: async () => undefined } },
      flavor: 'prod',
      buildSetId: INCUMBENT_BUILD,
      lifecycle: () => lifecycle,
      db: () => db,
      jobSettled: () => false,
      localOperationJobIds: () => [],
      hostRootRetained: () => true,
      attemptId: () => null,
      targetChangesStoreFormat: () => false,
      log,
    });
  }

  it("keeps installing a served host's grant until the host acknowledges it", async () => {
    const record = executing();
    const host = hostFor(record, authorized);
    const install = host.installRecoveryCredential as ReturnType<typeof vi.fn>;
    install
      .mockResolvedValueOnce(RETRYABLE)
      .mockRejectedValueOnce(new Error('lost reply'))
      .mockResolvedValue(INSTALLED);

    await transferOver(runtimeFor(), lifecycleWith([host]), record).completeTransfers();

    expect(install).toHaveBeenCalledTimes(3);
  });

  it('stops a refused grant retry when the host leaves during its backoff', async () => {
    const record = executing();
    let live = true;
    const install = vi.fn(async () => {
      live = false;
      return { kind: 'refused', incident: { role: 'guardian' } };
    });
    const host = {
      ...hostFor(record, authorized),
      installRecoveryCredential: install,
    } as unknown as DurableProviderProxyOperationAuthority;
    const lifecycle = {
      liveSets: () => (live ? [host] : []),
      authorityFor: () => host,
    } as unknown as ProviderProxySetLifecycle;

    await transferOver(runtimeFor(), lifecycle, record).completeTransfers();

    expect(install).toHaveBeenCalledOnce();
  });

  it('re-authorizes every host immediately before releasing it, so a reinstall since preparation cannot revoke the transfer', async () => {
    const record = executing();
    let transferAuthorized = false;
    const host = hostFor(record, async () => {
      transferAuthorized = true;
      return authorized();
    });
    const authorizedAtRelease: boolean[] = [];
    const lifecycle = {
      ...lifecycleWith([host]),
      releaseControlForTransfer: vi.fn(async () => {
        authorizedAtRelease.push(transferAuthorized);
        return [host.setIdentity];
      }),
    } as unknown as ProviderProxySetLifecycle;
    const transfer = transferOver(runtimeFor(), lifecycle, record);
    await classify(transfer);
    // A control reattachment reinstalls the identical grant, which the roles read as the controller taking it back.
    transferAuthorized = false;

    await transfer.releaseForTransfer('attempt-1', new AbortController().signal);

    expect(authorizedAtRelease).toEqual([true]);
  });

  it('releases nothing when a host no longer holds the grant the receipt names', async () => {
    const record = executing();
    let grant = RECOVERY_GRANT;
    const host = hostFor(record, async () => ({ kind: 'authorized', recoveryGrantId: grant }));
    const lifecycle = lifecycleWith([host]);
    const transfer = transferOver(runtimeFor(), lifecycle, record);
    await classify(transfer);
    grant = '44444444-4444-4444-8444-444444444444';

    await expect(transfer.releaseForTransfer('attempt-1', new AbortController().signal)).rejects.toThrow(
      /no longer authorizes/u,
    );
    expect(lifecycle.releaseControlForTransfer).not.toHaveBeenCalled();
  });

  it('should stop waiting for a host re-authorization when the commit deadline expires', async () => {
    const record = executing();
    let authorize: () => void = () => undefined;
    let calls = 0;
    const host = hostFor(record, () => {
      if (++calls === 1) return authorized();
      return new Promise<ControllerTransferOutcome>((resolve) => {
        authorize = () => resolve(authorized());
      });
    });
    const lifecycle = lifecycleWith([host]);
    const transfer = transferOver(runtimeFor(), lifecycle, record);
    await classify(transfer);
    const deadline = new AbortController();
    const release = transfer.releaseForTransfer('attempt-1', deadline.signal);
    deadline.abort();

    await expect(release).rejects.toThrow();
    authorize();
    expect(lifecycle.releaseControlForTransfer).not.toHaveBeenCalled();
  });

  it('should stop waiting for control close when the commit deadline expires', async () => {
    const record = executing();
    const host = hostFor(record, authorized);
    let controlCloseStarted!: () => void;
    const controlClose = new Promise<void>((resolve) => {
      controlCloseStarted = resolve;
    });
    const lifecycle = {
      ...lifecycleWith([host]),
      releaseControlForTransfer: vi.fn(() => {
        controlCloseStarted();
        return new Promise<never>(() => undefined);
      }),
    } as unknown as ProviderProxySetLifecycle;
    const transfer = transferOver(runtimeFor(), lifecycle, record);
    await classify(transfer);
    const deadline = new AbortController();
    const release = transfer.releaseForTransfer('attempt-1', deadline.signal);
    await controlClose;
    deadline.abort();

    await expect(release).rejects.toThrow();
  });
});
