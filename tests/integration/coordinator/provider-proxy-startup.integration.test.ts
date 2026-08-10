import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createExecutionServices } from '#src/coordinator/composition/execution-services.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set-lifecycle-ref.js';
import { attemptProviderProxySetInheritance } from '#src/coordinator/services/provider-proxy-set-inheritance.js';
import {
  ProviderOperationReconciler,
  StartupSetRecoveryProducer,
  type StartupSetRecoveryPort,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set-claim-mirror.js';
import {
  ProviderProxySetLifecycle,
  ProviderProxySetLifecycleFatalError,
  type DisappearanceDeliveryAttemptOutcome,
} from '#src/coordinator/services/provider-proxy-set-lifecycle.js';
import {
  providerProxySetIdentityFromRecord,
  providerProxySetKey,
} from '#src/coordinator/services/provider-proxy-set-identity.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationsDue,
} from '#src/store/provider-operation-journal.js';
import type { HandoffCapsuleV1, HandoffCapsuleV2 } from '#src/provider-proxy/handoff-capsule.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS, ProxyControlProtocolError } from '#src/provider-proxy/protocol.js';
import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import type { StorageBigIntStat, StoragePort } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function drainMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function createDb(records: readonly ProviderOperationRecord[]): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  for (const record of records) insertProviderOperation(db, record);
  return db;
}

function secondSetRecord(): ProviderOperationRecord {
  const base = providerOperationRecord('executing');
  const proxyInstanceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3';
  return providerOperationRecord('executing', {
    operation: {
      jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
      proxyInstanceId,
      buildSetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4',
    },
    locator: {
      ...base.locator,
      hostFingerprint: 'e'.repeat(64),
      guardian: {
        ...base.locator.guardian,
        instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5',
        controlEndpoint: '/tmp/startup-b-guardian.sock',
      },
      reaper: {
        ...base.locator.reaper,
        instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6',
        controlEndpoint: '/tmp/startup-b-reaper.sock',
      },
      proxy: {
        ...base.locator.proxy,
        instanceId: proxyInstanceId,
        controlEndpoint: '/tmp/startup-b-proxy.sock',
      },
    },
  });
}

function lifecycleFor(
  records: readonly ProviderOperationRecord[],
  options: Readonly<{
    time: VirtualTime;
    containmentDisappeared(notice: {
      operation: ProviderOperationRecord['operation'];
    }): Promise<DisappearanceDeliveryAttemptOutcome>;
    retireCapsule?: () =>
      | Readonly<{ kind: 'retired' }>
      | Readonly<{
          kind: 'temporarily-unavailable';
          incident: Readonly<{ kind: 'capsule-directory-durability-unavailable' }>;
        }>
      | Promise<
          | Readonly<{ kind: 'retired' }>
          | Readonly<{
              kind: 'temporarily-unavailable';
              incident: Readonly<{ kind: 'capsule-directory-durability-unavailable' }>;
            }>
        >;
    proveContainmentAbsent?: ProviderProxySetLifecycle['containmentAbsent'] extends never
      ? never
      : () => Promise<string | null>;
    redeemCapsule?: () => Promise<
      | Readonly<{ kind: 'redeemed'; set: never }>
      | Readonly<{
          kind: 'temporarily-unavailable';
          incident: Readonly<{ kind: 'recovery-deadline'; timeoutMs: 45_000 }>;
        }>
    >;
    onFatal?: (error: ProviderProxySetLifecycleFatalError) => void;
  }>,
): ProviderProxySetLifecycle {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize(records);
  const lifecycle = new ProviderProxySetLifecycle({
    claims,
    controlEstablished: () => undefined,
    disappearanceConsumer: {
      containmentDisappeared: (notice) => options.containmentDisappeared(notice),
    },
    time: options.time,
    proveContainmentAbsent: options.proveContainmentAbsent ?? (async () => null),
    retireCapsule: () => options.retireCapsule?.() ?? { kind: 'retired' },
    rewriteCapsule: () => undefined,
    onFatal: options.onFatal ?? (() => undefined),
    ...(options.redeemCapsule === undefined ? {} : { redeemCapsule: options.redeemCapsule }),
  });
  lifecycle.initializeClaimSlots();
  return lifecycle;
}

function reconcilerFor(
  db: Database,
  time: VirtualTime,
  startupSetRecovery: StartupSetRecoveryPort,
): ProviderOperationReconciler {
  return new ProviderOperationReconciler({
    getProgressStore: () => ({
      getDb: () => db,
      commit: () => {
        throw new Error('startup fixture unexpectedly committed a job event');
      },
      readStatus: () => null,
      readLaunchProjection: () => null,
    }),
    authorityFor: () => null,
    startupSetRecovery,
    registry: { activate: vi.fn(), attach: vi.fn(), settled: vi.fn(), stop: vi.fn() },
    materializePrepare: () => {
      throw new Error('startup fixture unexpectedly materialized prepare input');
    },
    recoverLocalJob: async () => {
      throw new Error('startup fixture unexpectedly recovered a local job');
    },
    completeLocalRecovery: () => undefined,
    terminalization: {
      terminalize: () => {
        throw new Error('startup fixture unexpectedly terminalized through an authority');
      },
    },
    backendNamespace: 'provider-proxy-startup-integration',
    time,
  });
}

function v1CapsuleFor(record: ProviderOperationRecord): HandoffCapsuleV1 {
  const identity = providerProxySetIdentityFromRecord(record);
  return {
    version: 1,
    grantId: randomUUID(),
    secret: 'c'.repeat(64),
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
  };
}

function v2CapsuleFor(record: ProviderOperationRecord): HandoffCapsuleV2 {
  const identity = providerProxySetIdentityFromRecord(record);
  return {
    ...v1CapsuleFor(record),
    version: 2,
    guardianPid: identity.guardianPid,
    guardianProcessStartedAtSeconds: identity.guardianProcessStartedAtSeconds,
    proxyPid: identity.proxyPid,
    reaperPid: identity.reaperPid,
    reaperProcessStartedAtSeconds: identity.reaperProcessStartedAtSeconds,
    containmentKind: identity.containmentKind,
    proxyProcessStartedAtSeconds: identity.proxyProcessStartedAtSeconds,
    proxyProcessGroupId: identity.proxyProcessGroupId,
  };
}

type ProductionStartupHarness = Readonly<{
  db: Database;
  time: VirtualTime;
  fatals: ReturnType<typeof vi.fn>;
  lifecycleRef: ProviderProxySetLifecycleRef;
  services: ReturnType<typeof createExecutionServices>;
}>;

function noCapsuleStorage(base: StoragePort): StoragePort {
  return { ...base, readdirSync: (() => []) as StoragePort['readdirSync'] };
}

function composeProductionStartup(
  record: ProviderOperationRecord,
  inheritance: unknown,
  options: Readonly<{ runtime?: Runtime }> = {},
): ProductionStartupHarness {
  const db = createDb([record]);
  const time = options.runtime === undefined ? new VirtualTime() : (options.runtime.time as VirtualTime);
  const baseRuntime = createRealRuntime('prod');
  const runtime =
    options.runtime ?? ({ ...baseRuntime, time, storage: noCapsuleStorage(baseRuntime.storage) } satisfies Runtime);
  const fatals = vi.fn();
  const lifecycleRef = new ProviderProxySetLifecycleRef();
  const progressStore = {
    getDb: () => db,
    commit: () => {
      throw new Error('production startup fixture unexpectedly committed a job event');
    },
    readStatus: () => null,
    readLaunchProjection: () => null,
  };
  const world = {
    storeServicesRef: { tryGet: () => ({ progressStore }) },
    operationRegistry: new LocalOperationRegistry(),
    providerProxyClaims: new ProviderProxySetClaimMirror(),
    providerProxyLifecycleRef: lifecycleRef,
    providerProxyInheritance: inheritance,
    providerHostManager: {},
  } as never;
  const services = createExecutionServices({
    world,
    runtime,
    bundleHash: 'provider-proxy-startup-integration',
    backendNamespace: 'provider-proxy-startup-integration',
    onProviderProxyLifecycleFatal: fatals,
    createExecutionService: (() => {
      throw new Error('production startup fixture unexpectedly created an execution service');
    }) as never,
  });
  return { db, time, fatals, lifecycleRef, services };
}

async function productionStartupOutcome(harness: ProductionStartupHarness) {
  return harness.services.reconcileProviderOperationsAtStartup(new AbortController().signal).then(
    (report) => ({ kind: 'fulfilled' as const, report }),
    (error: unknown) => ({ kind: 'rejected' as const, error }),
  );
}

function capsuleBackedStorage(
  base: StoragePort,
  generationRoot: string,
  capsule: HandoffCapsuleV1 | HandoffCapsuleV2,
  options: Readonly<{
    discover: boolean;
    unlink(): void;
    syncDirectoryDurableSync(): boolean;
  }>,
): Readonly<{ storage: StoragePort; path: string; exists(): boolean }> {
  const path = providerHandoffCapsulePath(capsule, { baseDir: dirname(generationRoot) });
  const bytes = Buffer.from(JSON.stringify(capsule));
  const uid = BigInt(process.getuid?.() ?? 0);
  const stat: StorageBigIntStat = {
    dev: 1n,
    ino: 2n,
    mode: BigInt(0o100600),
    uid,
    size: BigInt(bytes.length),
    mtimeNs: 3n,
    isDirectory: () => false,
    isFile: () => true,
  };
  let present = true;
  let offset = 0;
  const absent = (): Error => Object.assign(new Error('capsule absent'), { code: 'ENOENT' });
  const requirePresent = (): void => {
    if (!present) throw absent();
  };
  const storage = {
    ...base,
    readdirSync: (() => (options.discover && present ? [basename(path)] : [])) as unknown as StoragePort['readdirSync'],
    lstatSync: () => {
      requirePresent();
      return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
    },
    statSync: ((_path: string, statOptions?: { bigint: true }) => {
      requirePresent();
      return statOptions?.bigint === true
        ? stat
        : { size: bytes.length, mtimeMs: 0, isDirectory: () => false, isFile: () => true };
    }) as StoragePort['statSync'],
    openSync: () => {
      requirePresent();
      offset = 0;
      return 17;
    },
    fstatSync: () => stat,
    readSync: (_fd: number, buffer: Buffer, targetOffset: number, length: number) => {
      const count = Math.min(length, bytes.length - offset);
      if (count <= 0) return 0;
      bytes.copy(buffer, targetOffset, offset, offset + count);
      offset += count;
      return count;
    },
    closeSync: () => undefined,
    unlinkSync: () => {
      options.unlink();
      present = false;
    },
    syncDirectoryDurableSync: options.syncDirectoryDurableSync,
  } as StoragePort;
  return { storage, path, exists: () => present };
}

function guardianFields(record: ProviderOperationRecord, operations: readonly ProviderOperationRecord['operation'][]) {
  const identity = providerProxySetIdentityFromRecord(record);
  return {
    state: 'redeemed-provisional',
    redemptionReceipt: 'guardian-redemption-receipt',
    operations,
    guardian: {
      guardianInstanceId: identity.guardianInstanceId,
      pid: identity.guardianPid,
      processStartedAtSeconds: identity.guardianProcessStartedAtSeconds,
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: identity.buildSetId,
      hostFingerprint: identity.hostFingerprint,
      canonicalControlEndpoint: identity.guardianControlEndpoint,
    },
    reaper: {
      reaperInstanceId: identity.reaperInstanceId,
      pid: identity.reaperPid,
      processStartedAtSeconds: identity.reaperProcessStartedAtSeconds,
      guardianInstanceId: identity.guardianInstanceId,
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: identity.buildSetId,
      hostFingerprint: identity.hostFingerprint,
      canonicalControlEndpoint: identity.reaperControlEndpoint,
      containmentKind: identity.containmentKind,
    },
    containment: {
      pid: identity.proxyPid,
      processStartedAtSeconds: identity.proxyProcessStartedAtSeconds,
      processGroupId: identity.proxyProcessGroupId,
      containmentKind: identity.containmentKind,
    },
  };
}

function reaperFields(record: ProviderOperationRecord, operations: readonly ProviderOperationRecord['operation'][]) {
  return {
    state: 'successor-rotated',
    reaperRotationReceipt: 'reaper-rotation-receipt',
    operations,
    reaper: guardianFields(record, operations).reaper,
  };
}

function proxyFields(record: ProviderOperationRecord, operations: readonly ProviderOperationRecord['operation'][]) {
  const identity = providerProxySetIdentityFromRecord(record);
  return {
    state: 'redeemed-provisional',
    redemptionReceipt: 'proxy-redemption-receipt',
    operations,
    proxy: {
      proxyInstanceId: identity.proxyInstanceId,
      pid: identity.proxyPid,
      processStartedAtSeconds: identity.proxyProcessStartedAtSeconds,
      processGroupId: identity.proxyProcessGroupId,
      guardianInstanceId: identity.guardianInstanceId,
      reaperInstanceId: identity.reaperInstanceId,
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: identity.buildSetId,
      hostFingerprint: identity.hostFingerprint,
      canonicalEndpoint: identity.canonicalEndpoint,
    },
  };
}

async function startRoleEndpoint(
  options: Readonly<{
    path: string;
    heartbeatMethod: string;
    openMethod: string;
    fields: Record<string, unknown>;
    time: VirtualTime;
    open(params: unknown): Promise<void>;
  }>,
) {
  let challenge = 0;
  const nextChallenge = (): string => `startup-role-challenge-${challenge++}`;
  const challenges: ControlChallengeAuthority = {
    issueFirstChallenge: () => ({ accepted: true, challenge: nextChallenge() }),
    admitSuccessor: () => ({ accepted: true, challenge: nextChallenge() }),
    reattachControl: () => ({ accepted: true }),
    controlIsLive: () => true,
    echoChallenge: () => ({ accepted: true, nextChallenge: nextChallenge() }),
  };
  const endpoint = createControlEndpoint({
    socketPath: options.path,
    role: {
      heartbeatMethod: options.heartbeatMethod,
      methods: new Map([
        [
          options.openMethod,
          {
            authority: 'establishes-control' as const,
            handle: async (params: unknown) => {
              await options.open(params);
              return { holder: 'startup-successor', fields: options.fields };
            },
          },
        ],
      ]),
    },
    challenges,
    observer: { onControlLost: () => undefined },
    timer: options.time,
    requestTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS + 1_000,
  });
  await endpoint.listen();
  return endpoint;
}

async function roleRecoveryStartupCase(
  mode: 'operation-set-disagreement' | 'protocol-violation' | 'grant-replayed' | 'timeout',
) {
  const record = providerOperationRecord('executing');
  const time = new VirtualTime();
  const realRuntime = createRealRuntime('prod');
  const capsule = v1CapsuleFor(record);
  const capsuleStorage = capsuleBackedStorage(realRuntime.storage, realRuntime.paths.coral.generation.root, capsule, {
    discover: false,
    unlink: () => undefined,
    syncDirectoryDurableSync: () => true,
  });
  const runtime = { ...realRuntime, time, storage: capsuleStorage.storage } satisfies Runtime;
  const alternateOperation = { ...record.operation, jobId: randomUUID(), operationId: randomUUID() };
  const guardianOpen = vi.fn(async () => {
    if (mode === 'protocol-violation') throw new Error('remote protocol refusal');
    if (mode === 'grant-replayed') {
      throw new ProxyControlProtocolError('grant_replayed', 'The handoff grant was already redeemed.');
    }
    if (mode === 'timeout') await new Promise<never>(() => undefined);
  });
  const reaperOpen = vi.fn(async () => undefined);
  const proxyOpen = vi.fn(async () => undefined);
  const endpoints = await Promise.all([
    startRoleEndpoint({
      path: record.locator.guardian.controlEndpoint,
      heartbeatMethod: 'guardian.heartbeat.v1',
      openMethod: 'guardian.handoff-redeem.v1',
      fields: guardianFields(record, [record.operation]),
      time,
      open: guardianOpen,
    }),
    startRoleEndpoint({
      path: record.locator.reaper.controlEndpoint,
      heartbeatMethod: 'reaper.heartbeat.v1',
      openMethod: 'reaper.handoff-rotate.v1',
      fields: reaperFields(record, [record.operation]),
      time,
      open: reaperOpen,
    }),
    startRoleEndpoint({
      path: record.locator.proxy.controlEndpoint,
      heartbeatMethod: 'control.heartbeat.v1',
      openMethod: 'handoff.redeem.v1',
      fields: proxyFields(record, mode === 'operation-set-disagreement' ? [alternateOperation] : [record.operation]),
      time,
      open: proxyOpen,
    }),
  ]);
  const operationRegistry = new LocalOperationRegistry();
  const inheritance = {
    inheritProviderProxySet: (locator: ProviderOperationRecord, db: Database, signal: AbortSignal) =>
      attemptProviderProxySetInheritance(
        locator,
        db,
        {
          runtime,
          baseDir: dirname(runtime.paths.coral.generation.root),
          coordinatorIdentity: {
            instanceId: randomUUID(),
            pid: process.pid,
            processStartedAtSeconds: 1,
            generation: 'gen2',
            flavor: 'prod',
            buildSetId: record.operation.buildSetId,
          },
          operationRegistry,
          proveContainmentAbsent: async () => null,
        },
        signal,
      ),
    redeemDiscoveredCapsule: async () => {
      throw new Error('capsule discovery redemption was not expected');
    },
    proveContainmentAbsent: async () => null,
  };
  const harness = composeProductionStartup(record, inheritance, { runtime });
  const startup = productionStartupOutcome(harness);
  if (mode === 'timeout') {
    await vi.waitFor(() => expect(guardianOpen).toHaveBeenCalledOnce());
    time.tick(PROXY_CONTROL_RPC_TIMEOUT_MS);
  }
  const outcome = await startup;
  const current = readProviderOperation(harness.db, record.operation);
  const result = {
    outcome,
    fatalCalls: harness.fatals.mock.calls.length,
    openCalls: [guardianOpen.mock.calls.length, reaperOpen.mock.calls.length, proxyOpen.mock.calls.length],
    current,
    dueRows: readProviderOperationsDue(harness.db, Number.MAX_SAFE_INTEGER, 4),
  };
  harness.services.stopProviderOperationReconciler();
  for (const endpoint of endpoints) await endpoint.close();
  harness.db.close();
  return result;
}

async function capsuleRetirementStartupCase(mode: 'unlink-throws' | 'directory-sync-unavailable') {
  const record = providerOperationRecord('settlement-pending');
  const time = new VirtualTime();
  const scheduled = vi.spyOn(time, 'setTimeout');
  const realRuntime = createRealRuntime('prod');
  const unlinkSentinel = new Error('unlink sentinel');
  const unlink = vi.fn(() => {
    if (mode === 'unlink-throws') throw unlinkSentinel;
  });
  const syncDirectoryDurableSync = vi.fn(() => mode !== 'directory-sync-unavailable');
  const capsuleStorage = capsuleBackedStorage(
    realRuntime.storage,
    realRuntime.paths.coral.generation.root,
    v2CapsuleFor(record),
    { discover: true, unlink, syncDirectoryDurableSync },
  );
  const runtime = { ...realRuntime, time, storage: capsuleStorage.storage } satisfies Runtime;
  const inheritance = {
    inheritProviderProxySet: async () => ({
      kind: 'containment-disappeared' as const,
      disappearanceReceipt: 'retirement-absence-proof',
    }),
    redeemDiscoveredCapsule: async () => new Promise<never>(() => undefined),
    proveContainmentAbsent: async () => new Promise<never>(() => undefined),
  };
  const harness = composeProductionStartup(record, inheritance, { runtime });
  const outcome = await productionStartupOutcome(harness);
  const result = {
    outcome,
    fatalCalls: harness.fatals.mock.calls.length,
    timerCalls: scheduled.mock.calls.length,
    unlinkCalls: unlink.mock.calls.length,
    syncCalls: syncDirectoryDurableSync.mock.calls.length,
    capsuleExists: capsuleStorage.exists(),
  };
  harness.services.stopProviderOperationReconciler();
  harness.db.close();
  return result;
}

describe('provider proxy startup set recovery', () => {
  it('shares one recovery promise while same-set delivery is gated', async () => {
    const record = providerOperationRecord('executing');
    const time = new VirtualTime();
    const delivery = deferred<DisappearanceDeliveryAttemptOutcome>();
    const lifecycle = lifecycleFor([record], {
      time,
      containmentDisappeared: () => delivery.promise,
    });
    lifecycle.completeStartupDiscovery();
    const identity = providerProxySetIdentityFromRecord(record);
    const recover = vi.fn(async () => ({
      kind: 'absence-accepted' as const,
      acceptance: lifecycle.containmentAbsent(identity, 'shared-proof'),
    }));
    const producer = new StartupSetRecoveryProducer(recover);
    const work = { key: providerProxySetKey(identity), identity, operations: [record.operation] };

    const first = producer.recoverSetAtStartup(work, new AbortController().signal);
    const second = producer.recoverSetAtStartup(work, new AbortController().signal);

    expect({ sharedPromise: second === first, proofCalls: recover.mock.calls.length }).toEqual({
      sharedPromise: true,
      proofCalls: 1,
    });
    delivery.resolve({
      kind: 'accepted',
      acceptance: { kind: 'accepted', operation: record.operation, disposition: 'record-absent' },
    });
    await expect(first).resolves.toMatchObject({ kind: 'absence-accepted' });
  });

  it('retires an unmatched exact v2 capsule after independent absence proof', async () => {
    const record = providerOperationRecord('executing');
    const time = new VirtualTime();
    const scheduled = vi.spyOn(time, 'setTimeout');
    const proof = vi.fn(async () => 'exact-v2-proof');
    const retirementStarted = deferred<void>();
    const retirementOutcome = deferred<Readonly<{ kind: 'retired' }>>();
    const retirement = vi.fn(() => {
      retirementStarted.resolve();
      return retirementOutcome.promise;
    });
    const redemption = vi.fn(async () => ({
      kind: 'temporarily-unavailable' as const,
      incident: { kind: 'recovery-deadline' as const, timeoutMs: 45_000 as const },
    }));
    const lifecycle = lifecycleFor([], {
      time,
      containmentDisappeared: async () => {
        throw new Error('zero-claim capsule must not deliver an operation');
      },
      proveContainmentAbsent: proof,
      redeemCapsule: redemption,
      retireCapsule: retirement,
    });

    const capsule = v2CapsuleFor(record);
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/startup-v2.handoff.json', capsule }]);
    await retirementStarted.promise;
    retirementOutcome.resolve({ kind: 'retired' });
    await retirementOutcome.promise;
    await drainMicrotasks();

    const snapshot = lifecycle.snapshot();
    expect({
      proofCalls: proof.mock.calls.length,
      redemptionCalls: redemption.mock.calls.length,
      retirementCalls: retirement.mock.calls.length,
      retrySchedules: scheduled.mock.calls.length,
      represented: snapshot.represented,
      states: snapshot.states,
      admission: lifecycle.beginFreshAcquisition('restored-admission', {
        buildSetId: capsule.buildSetId,
        hostFingerprint: capsule.hostFingerprint,
      }).kind,
    }).toEqual({
      proofCalls: 1,
      redemptionCalls: 1,
      retirementCalls: 1,
      retrySchedules: 0,
      represented: 0,
      states: [],
      admission: 'accepted',
    });
  });

  it('continues to set B after persistent disappearance-delivery failure', async () => {
    const setA = providerOperationRecord('executing');
    const setB = secondSetRecord();
    const db = createDb([setA, setB]);
    const time = new VirtualTime();
    const scheduled = vi.spyOn(time, 'setTimeout');
    const lifecycle = lifecycleFor([setA, setB], {
      time,
      containmentDisappeared: async () => ({
        kind: 'operational-failure',
        code: 'disappearance_consumer_unavailable',
        reason: 'journal temporarily unavailable',
      }),
    });
    lifecycle.completeStartupDiscovery();
    const identityA = providerProxySetIdentityFromRecord(setA);
    const setBVisits = vi.fn();
    const startupSetRecovery: StartupSetRecoveryPort = {
      recoverSetAtStartup: async (work) => {
        if (work.key === providerProxySetKey(identityA)) {
          return { kind: 'absence-accepted', acceptance: lifecycle.containmentAbsent(identityA, 'set-a-proof') };
        }
        setBVisits();
        return { kind: 'retry-scheduled', reason: 'set B retained for retry', nextAttemptAtMs: 25 };
      },
    };

    const abort = new AbortController();
    let settled = false;
    const startup = reconcilerFor(db, time, startupSetRecovery)
      .reconcileAtStartup(abort.signal)
      .then(
        (report) => ({ kind: 'fulfilled' as const, report }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true;
      });
    await drainMicrotasks();
    const beforeAbort = {
      setBVisits: setBVisits.mock.calls.length,
      retrySchedules: scheduled.mock.calls.length,
      settled,
    };
    abort.abort(new Error('startup delivery mutation observation complete'));
    const outcome = await startup;

    expect({ ...beforeAbort, outcome: outcome.kind }).toEqual({
      setBVisits: 1,
      retrySchedules: 1,
      settled: true,
      outcome: 'fulfilled',
    });
    expect(outcome.kind === 'fulfilled' ? outcome.report.incidents : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'absence-retry-owned' }),
        expect.objectContaining({ kind: 'set-retry-scheduled', setIdentity: providerProxySetIdentityFromRecord(setB) }),
      ]),
    );
    expect(lifecycle.snapshot()).toMatchObject({ states: expect.arrayContaining(['absence-delivery-pending']) });
    expect(scheduled).toHaveBeenCalledOnce();
  });

  it('continues to set B after persistent capsule-retirement failure', async () => {
    const setA = providerOperationRecord('executing');
    const setB = secondSetRecord();
    const db = createDb([setA, setB]);
    const time = new VirtualTime();
    const scheduled = vi.spyOn(time, 'setTimeout');
    const lifecycle = lifecycleFor([setA, setB], {
      time,
      containmentDisappeared: async (notice) => ({
        kind: 'accepted',
        acceptance: { kind: 'accepted', operation: notice.operation, disposition: 'record-absent' },
      }),
      retireCapsule: () => ({
        kind: 'temporarily-unavailable',
        incident: { kind: 'capsule-directory-durability-unavailable' },
      }),
    });
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/set-a.handoff.json', capsule: v1CapsuleFor(setA) }]);
    const identityA = providerProxySetIdentityFromRecord(setA);
    const setBVisits = vi.fn();
    const startupSetRecovery: StartupSetRecoveryPort = {
      recoverSetAtStartup: async (work) => {
        if (work.key === providerProxySetKey(identityA)) {
          return { kind: 'absence-accepted', acceptance: lifecycle.containmentAbsent(identityA, 'set-a-proof') };
        }
        setBVisits();
        return { kind: 'retry-scheduled', reason: 'set B retained for retry', nextAttemptAtMs: 25 };
      },
    };

    const abort = new AbortController();
    let settled = false;
    const startup = reconcilerFor(db, time, startupSetRecovery)
      .reconcileAtStartup(abort.signal)
      .then(
        (report) => ({ kind: 'fulfilled' as const, report }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true;
      });
    await drainMicrotasks();
    const beforeAbort = {
      setBVisits: setBVisits.mock.calls.length,
      retrySchedules: scheduled.mock.calls.length,
      settled,
    };
    abort.abort(new Error('startup retirement mutation observation complete'));
    const outcome = await startup;

    expect({ ...beforeAbort, outcome: outcome.kind }).toEqual({
      setBVisits: 1,
      retrySchedules: 1,
      settled: true,
      outcome: 'fulfilled',
    });
    expect(outcome.kind === 'fulfilled' ? outcome.report.incidents : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'absence-retry-owned',
          incident: expect.objectContaining({ stage: 'capsule-retirement' }),
        }),
      ]),
    );
    expect(lifecycle.snapshot()).toMatchObject({ states: expect.arrayContaining(['absence-delivery-pending']) });
    expect(scheduled).toHaveBeenCalledOnce();
  });

  it('aborts while disappearance initial disposition is pending', async () => {
    const setA = providerOperationRecord('executing');
    const db = createDb([setA]);
    const time = new VirtualTime();
    const deliveryStarted = deferred<void>();
    const delivery = deferred<DisappearanceDeliveryAttemptOutcome>();
    const lifecycle = lifecycleFor([setA], {
      time,
      containmentDisappeared: () => {
        deliveryStarted.resolve();
        return delivery.promise;
      },
    });
    lifecycle.completeStartupDiscovery();
    const identity = providerProxySetIdentityFromRecord(setA);
    const startupSetRecovery: StartupSetRecoveryPort = {
      recoverSetAtStartup: async () => ({
        kind: 'absence-accepted',
        acceptance: lifecycle.containmentAbsent(identity, 'abort-proof'),
      }),
    };
    const abort = new AbortController();
    const reason = new Error('supplied startup abort reason');
    const startup = reconcilerFor(db, time, startupSetRecovery).reconcileAtStartup(abort.signal);
    let settled = false;
    const outcomePromise = startup
      .then(
        () => ({ kind: 'fulfilled' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true;
      });
    await deliveryStarted.promise;

    abort.abort(reason);
    await drainMicrotasks();
    const settledAfterAbort = settled;
    delivery.resolve({
      kind: 'accepted',
      acceptance: { kind: 'accepted', operation: setA.operation, disposition: 'record-absent' },
    });
    const outcome = await outcomePromise;

    expect({
      settledAfterAbort,
      outcome: outcome.kind,
      exactReason: outcome.kind === 'rejected' && outcome.error === reason,
    }).toEqual({ settledAfterAbort: true, outcome: 'rejected', exactReason: true });
  });

  it('rejects startup on fatal disappearance identity corruption', async () => {
    const setA = providerOperationRecord('executing');
    const setB = secondSetRecord();
    const db = createDb([setA, setB]);
    const time = new VirtualTime();
    const fatals = vi.fn();
    const lifecycle = lifecycleFor([setA, setB], {
      time,
      containmentDisappeared: async (notice) => ({
        kind: 'accepted',
        acceptance: {
          kind: 'accepted',
          operation: { ...notice.operation, operationId: randomUUID() },
          disposition: 'record-absent',
        },
      }),
      onFatal: fatals,
    });
    lifecycle.completeStartupDiscovery();
    const identityA = providerProxySetIdentityFromRecord(setA);
    const setBVisits = vi.fn();
    const startupSetRecovery: StartupSetRecoveryPort = {
      recoverSetAtStartup: async (work) => {
        if (work.key === providerProxySetKey(identityA)) {
          return { kind: 'absence-accepted', acceptance: lifecycle.containmentAbsent(identityA, 'fatal-proof') };
        }
        setBVisits();
        return { kind: 'retry-scheduled', reason: 'must not reach set B', nextAttemptAtMs: 25 };
      },
    };

    const outcome = await reconcilerFor(db, time, startupSetRecovery)
      .reconcileAtStartup(new AbortController().signal)
      .then(
        () => ({ kind: 'fulfilled' as const, fatal: false }),
        (error: unknown) => ({
          kind: 'rejected' as const,
          fatal: error instanceof ProviderProxySetLifecycleFatalError,
        }),
      );

    expect({
      outcome: outcome.kind,
      fatal: outcome.fatal,
      fatalPortCalls: fatals.mock.calls.length,
      setBVisits: setBVisits.mock.calls.length,
    }).toEqual({ outcome: 'rejected', fatal: true, fatalPortCalls: 1, setBVisits: 0 });
  });
});

describe('production provider proxy startup classification', () => {
  it('fails startup when disappearance terminal metadata is corrupt', async () => {
    const record = providerOperationRecord('executing');
    const inheritance = {
      inheritProviderProxySet: async () => ({
        kind: 'containment-disappeared' as const,
        disappearanceReceipt: 'missing-terminal-metadata-proof',
      }),
      redeemDiscoveredCapsule: async () => {
        throw new Error('capsule redemption was not expected');
      },
      proveContainmentAbsent: async () => null,
    };
    const harness = composeProductionStartup(record, inheritance);
    const outcome = await productionStartupOutcome(harness);

    expect({
      outcome: outcome.kind,
      lifecycleFatal: outcome.kind === 'rejected' && outcome.error instanceof ProviderProxySetLifecycleFatalError,
      fatalCalls: harness.fatals.mock.calls.length,
      absenceRetryIncidents:
        outcome.kind === 'fulfilled'
          ? outcome.report.incidents.filter((incident) => incident.kind === 'absence-retry-owned').length
          : 0,
      rowSurvives: readProviderOperation(harness.db, record.operation) !== null,
    }).toEqual({
      outcome: 'rejected',
      lifecycleFatal: true,
      fatalCalls: 1,
      absenceRetryIncidents: 0,
      rowSurvives: true,
    });
    harness.services.stopProviderOperationReconciler();
    harness.db.close();
  });

  it('classifies role recovery evidence by cause', async () => {
    const disagreement = await roleRecoveryStartupCase('operation-set-disagreement');
    const timeout = await roleRecoveryStartupCase('timeout');

    expect({
      disagreement: {
        outcome: disagreement.outcome.kind,
        lifecycleFatal:
          disagreement.outcome.kind === 'rejected' &&
          disagreement.outcome.error instanceof ProviderProxySetLifecycleFatalError,
        fatalCalls: disagreement.fatalCalls,
        openCalls: disagreement.openCalls,
        retryOwned: disagreement.dueRows.length,
      },
      timeout: {
        outcome: timeout.outcome.kind,
        fatalCalls: timeout.fatalCalls,
        openCalls: timeout.openCalls,
        retryOwned: timeout.dueRows.length,
        retryCode: timeout.current?.lastError?.code,
      },
    }).toEqual({
      disagreement: {
        outcome: 'rejected',
        lifecycleFatal: true,
        fatalCalls: 1,
        openCalls: [1, 1, 1],
        retryOwned: 0,
      },
      timeout: {
        outcome: 'fulfilled',
        fatalCalls: 0,
        openCalls: [1, 0, 0],
        retryOwned: 1,
        retryCode: 'provider_proxy_set_recovery_unavailable',
      },
    });
  });

  it('treats remote handoff refusal as fatal and transport loss as retryable', async () => {
    const protocolViolation = await roleRecoveryStartupCase('protocol-violation');
    const grantReplayed = await roleRecoveryStartupCase('grant-replayed');
    const timeout = await roleRecoveryStartupCase('timeout');

    expect({
      protocolViolation: {
        outcome: protocolViolation.outcome.kind,
        fatalCalls: protocolViolation.fatalCalls,
        retryOwned: protocolViolation.dueRows.length,
      },
      grantReplayed: {
        outcome: grantReplayed.outcome.kind,
        fatalCalls: grantReplayed.fatalCalls,
        retryOwned: grantReplayed.dueRows.length,
      },
      timeout: {
        outcome: timeout.outcome.kind,
        fatalCalls: timeout.fatalCalls,
        retryOwned: timeout.dueRows.length,
      },
    }).toEqual({
      protocolViolation: { outcome: 'rejected', fatalCalls: 1, retryOwned: 0 },
      grantReplayed: { outcome: 'rejected', fatalCalls: 1, retryOwned: 0 },
      timeout: { outcome: 'fulfilled', fatalCalls: 0, retryOwned: 1 },
    });
  });

  it('classifies capsule retirement only from producer storage evidence', async () => {
    const unknownUnlink = await capsuleRetirementStartupCase('unlink-throws');
    const directorySyncUnavailable = await capsuleRetirementStartupCase('directory-sync-unavailable');

    expect({
      unknownUnlink: {
        outcome: unknownUnlink.outcome.kind,
        lifecycleFatal:
          unknownUnlink.outcome.kind === 'rejected' &&
          unknownUnlink.outcome.error instanceof ProviderProxySetLifecycleFatalError,
        fatalCalls: unknownUnlink.fatalCalls,
        timerCalls: unknownUnlink.timerCalls,
        unlinkCalls: unknownUnlink.unlinkCalls,
        syncCalls: unknownUnlink.syncCalls,
        capsuleExists: unknownUnlink.capsuleExists,
      },
      directorySyncUnavailable: {
        outcome: directorySyncUnavailable.outcome.kind,
        fatalCalls: directorySyncUnavailable.fatalCalls,
        timerCalls: directorySyncUnavailable.timerCalls,
        unlinkCalls: directorySyncUnavailable.unlinkCalls,
        syncCalls: directorySyncUnavailable.syncCalls,
      },
    }).toEqual({
      unknownUnlink: {
        outcome: 'rejected',
        lifecycleFatal: true,
        fatalCalls: 1,
        timerCalls: 0,
        unlinkCalls: 1,
        syncCalls: 0,
        capsuleExists: true,
      },
      directorySyncUnavailable: {
        outcome: 'fulfilled',
        fatalCalls: 0,
        timerCalls: 1,
        unlinkCalls: 1,
        syncCalls: 1,
      },
    });
  });
});
