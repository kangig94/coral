import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createExecutionServices } from '#src/coordinator/composition/execution-services.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set/lifecycle-ref.js';
import {
  attemptProviderProxySetInheritance,
  createProviderProxySetInheritance,
  type ProviderProxySetRedemptionOutcome,
} from '#src/coordinator/services/provider-proxy-set/inheritance.js';
import {
  ProviderOperationReconciler,
  StartupSetRecoveryProducer,
  type StartupSetRecoveryPort,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycle } from '#src/coordinator/services/provider-proxy-set/index.js';
import type { DisappearanceDeliveryAttemptOutcome } from '#src/coordinator/services/provider-containment-disappearance.js';
import {
  isProviderProxyRecoveryFatalError,
  type ProviderProxySetLifecycleFatalError,
} from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import {
  providerProxySetIdentityFromRecord,
  providerProxySetKey,
} from '#src/coordinator/services/provider-proxy-set/identity.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  insertProviderOperation,
  readProviderOperation,
  readProviderOperationsDue,
} from '#src/store/provider-operation-journal.js';
import type { HandoffCapsuleV1, HandoffCapsuleV3 } from '#src/provider-proxy/handoff-capsule.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { createControlEndpoint, type ControlChallengeAuthority } from '#src/provider-proxy/control-endpoint.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS, ProxyControlProtocolError } from '#src/provider-proxy/protocol.js';
import { providerHandoffCapsulePath } from '#src/infra/path/index.js';
import type { StorageBigIntStat, StoragePort, TimePort, TimerHandle } from '#src/infra/port-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ProcessPort, Runtime } from '#src/runtime/ports.js';
import { ProviderOperationTerminalizationUnavailableError } from '#src/jobs/provider-operation-terminalization.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';

/** The build this fixture lifecycle belongs to — the same one `providerOperationRecord` stamps on its identities, so a discovered capsule is inheritable rather than foreign. */
const FIXTURE_BUILD_SET_ID = '00000000-0000-4000-8000-000000000004';

/** Nothing observed is never absence, so every discovered capsule is retained and no retirement begins. */
const retainsEveryCapsule = { observeRecordedProcess: () => 'unknown' as const };

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve(value: T): void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function controlledRecoveryDeadline(base: VirtualTime): Readonly<{
  time: TimePort;
  armed: Promise<void>;
  fire(): void;
}> {
  const armed = deferred<void>();
  const deadlineHandle: TimerHandle = { unref: () => undefined };
  let deadlineCallback: (() => void) | null = null;
  const time: TimePort = {
    now: () => base.now(),
    monotonicNow: () => base.monotonicNow(),
    sleep: (ms, options) => base.sleep(ms, options),
    setTimeout: (callback, ms) => {
      if (ms !== 45_000) return base.setTimeout(callback, ms);
      deadlineCallback = callback;
      armed.resolve(undefined);
      return deadlineHandle;
    },
    clearTimeout: (handle) => {
      if (handle === deadlineHandle) {
        deadlineCallback = null;
        return;
      }
      base.clearTimeout(handle);
    },
    setInterval: (callback, ms) => base.setInterval(callback, ms),
    clearInterval: (handle) => base.clearInterval(handle),
  };
  return {
    time,
    armed: armed.promise,
    fire: () => {
      const callback = deadlineCallback;
      if (callback === null) throw new Error('provider proxy recovery deadline was not armed');
      callback();
    },
  };
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

function deadlinePrecedenceRecord(): ProviderOperationRecord {
  const base = providerOperationRecord('executing');
  const suffix = randomUUID();
  return providerOperationRecord('executing', {
    operation: base.operation,
    locator: {
      ...base.locator,
      guardian: { ...base.locator.guardian, controlEndpoint: `/tmp/coral-r17-guardian-${suffix}.sock` },
      reaper: { ...base.locator.reaper, controlEndpoint: `/tmp/coral-r17-reaper-${suffix}.sock` },
      proxy: { ...base.locator.proxy, controlEndpoint: `/tmp/coral-r17-proxy-${suffix}.sock` },
    },
  });
}

function lifecycleFor(
  records: readonly ProviderOperationRecord[],
  options: Readonly<{
    time: TimePort;
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
    proveContainmentAbsent?: (
      identity: ReturnType<typeof providerProxySetIdentityFromRecord>,
      signal: AbortSignal,
    ) => Promise<string | null>;
    redeemCapsule?: (
      capsule: HandoffCapsuleV3,
      path: string,
      signal: AbortSignal,
    ) => Promise<ProviderProxySetRedemptionOutcome>;
    onFatal?: (error: ProviderProxySetLifecycleFatalError) => void;
  }>,
): ProviderProxySetLifecycle {
  const claims = new ProviderProxySetClaimMirror();
  claims.initialize(records);
  const proveContainmentAbsent = options.proveContainmentAbsent ?? (async () => null);
  const retireCapsule = () => options.retireCapsule?.() ?? { kind: 'retired' as const };
  const onFatal = options.onFatal ?? (() => undefined);
  const redeemCapsule = options.redeemCapsule;
  const recoveryDispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      'containment-proof': ({ identity, signal }) => proveContainmentAbsent(identity, signal),
      'capsule-retirement': retireCapsule,
      ...(redeemCapsule === undefined
        ? {}
        : { 'capsule-redemption': ({ capsule, capsulePath, signal }) => redeemCapsule(capsule, capsulePath, signal) }),
      'disappearance-consumer': ({ notice }) => options.containmentDisappeared(notice),
    },
    onFatal,
  );
  const lifecycle = new ProviderProxySetLifecycle({
    buildSetId: FIXTURE_BUILD_SET_ID,
    claims,
    controlEstablished: () => undefined,
    time: options.time,
    recoveryDispatcher,
    reportLifecycle: () => undefined,
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
    recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({}),
    backendNamespace: 'provider-proxy-startup-integration',
    onFatal: (error) => {
      throw error;
    },
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

function v3CapsuleFor(record: ProviderOperationRecord): HandoffCapsuleV3 {
  const identity = providerProxySetIdentityFromRecord(record);
  return {
    ...v1CapsuleFor(record),
    version: 3,
    guardianPid: identity.guardianPid,
    guardianIncarnation: identity.guardianIncarnation,
    proxyPid: identity.proxyPid,
    reaperPid: identity.reaperPid,
    reaperIncarnation: identity.reaperIncarnation,
    containmentKind: identity.containmentKind,
    proxyIncarnation: identity.proxyIncarnation,
    proxyProcessGroupId: identity.proxyProcessGroupId,
  };
}

type ProductionStartupHarness = Readonly<{
  db: Database;
  time: TimePort;
  fatals: ReturnType<typeof vi.fn>;
  lifecycleRef: ProviderProxySetLifecycleRef;
  services: ReturnType<typeof createExecutionServices>;
}>;

/** Later than every `incarnation` the shared fixture records, so no recorded identity can match. */
const FIXTURE_PROCESS_LONG_GONE_INCARNATION = testIncarnation(9_000);

function noCapsuleStorage(base: StoragePort): StoragePort {
  return { ...base, readdirSync: (() => []) as StoragePort['readdirSync'] };
}

/**
 * Startup reconciliation reaps recorded containment, and the real process port would answer that from the
 * machine's own process table — where the fixture's pids 101-104 are low system pids that exist, whose
 * `/proc` entries may or may not be readable, and whose readability decides whether the reaper stops at an
 * identity mismatch or proceeds to signal. That makes the assertion depend on what else is running.
 *
 * These recorded processes are meant to be gone. Saying so directly keeps the reap deterministic: a start
 * time is always readable and never matches what the fixture recorded, which is the mismatch the reaper reads
 * as absence. Nothing here reaches the operating system.
 */
/** A runtime that reaches neither the developer's capsules nor their process table, on the supplied clock. */
function sandboxedRuntime(time: TimePort): Runtime {
  const base = createRealRuntime('prod');
  return {
    ...base,
    time,
    storage: noCapsuleStorage(base.storage),
    process: absentProcessPort(base.process),
  } satisfies Runtime;
}

function absentProcessPort(base: ProcessPort): ProcessPort {
  return {
    ...base,
    observeLiveness: () => 'absent' as const,
    kill: () => false,
    readProcessIncarnation: () => FIXTURE_PROCESS_LONG_GONE_INCARNATION,
  };
}

function composeProductionStartup(
  record: ProviderOperationRecord,
  inheritance: unknown,
  options: Readonly<{
    /** For a case that stages capsules on disk: its storage is the fixture, so the sandbox steps aside. */
    runtime?: Runtime;
    /** For a case that only wants to drive the clock, and should keep the sandbox. */
    time?: TimePort;
    progressStore?: Partial<Pick<JobProgressStore, 'commit' | 'readStatus' | 'readLaunchProjection'>>;
  }> = {},
): ProductionStartupHarness {
  const db = createDb([record]);
  // Wanting a clock and wanting the host's filesystem are different asks. Only a case that stages capsules
  // itself passes a runtime now; asking for a clock keeps the sandbox.
  const runtime = options.runtime ?? sandboxedRuntime(options.time ?? new VirtualTime());
  const { time } = runtime;
  const fatals = vi.fn();
  const lifecycleRef = new ProviderProxySetLifecycleRef();
  const progressStore = {
    getDb: () => db,
    commit: () => {
      throw new Error('production startup fixture unexpectedly committed a job event');
    },
    readStatus: () => null,
    readLaunchProjection: () => null,
    ...options.progressStore,
  };
  const world = {
    identity: { buildSetId: FIXTURE_BUILD_SET_ID },
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
  capsule: HandoffCapsuleV1 | HandoffCapsuleV3,
  options: Readonly<{
    discover: boolean;
    unlink(): void;
    syncDirectoryDurableSync(): boolean;
  }>,
): Readonly<{ storage: StoragePort; path: string; exists(): boolean }> {
  const path = providerHandoffCapsulePath(capsule, capsule.version, { baseDir: dirname(generationRoot) });
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
    lstatSync: (() => {
      requirePresent();
      return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
    }) as unknown as StoragePort['lstatSync'],
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
      incarnation: identity.guardianIncarnation,
      generation: 'gen2',
      flavor: 'prod',
      buildSetId: identity.buildSetId,
      hostFingerprint: identity.hostFingerprint,
      canonicalControlEndpoint: identity.guardianControlEndpoint,
    },
    reaper: {
      reaperInstanceId: identity.reaperInstanceId,
      pid: identity.reaperPid,
      incarnation: identity.reaperIncarnation,
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
      incarnation: identity.proxyIncarnation,
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
      incarnation: identity.proxyIncarnation,
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
  const record = deadlinePrecedenceRecord();
  const time = new VirtualTime();
  const realRuntime = createRealRuntime('prod');
  const capsule = v3CapsuleFor(record);
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
            incarnation: testIncarnation(1),
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

async function inheritanceDeadlinePrecedenceStartupCase(mode: 'disagreement' | 'deadline-only') {
  const record = deadlinePrecedenceRecord();
  const endpointTime = new VirtualTime();
  const deadline = controlledRecoveryDeadline(endpointTime);
  const realRuntime = createRealRuntime('prod');
  const capsule = v3CapsuleFor(record);
  const capsuleStorage = capsuleBackedStorage(realRuntime.storage, realRuntime.paths.coral.generation.root, capsule, {
    discover: false,
    unlink: () => undefined,
    syncDirectoryDurableSync: () => true,
  });
  const runtime = { ...realRuntime, time: deadline.time, storage: capsuleStorage.storage } satisfies Runtime;
  const alternateOperation = { ...record.operation, jobId: randomUUID(), operationId: randomUUID() };
  const releaseFinalResponse = deferred<void>();
  const guardianOpen = vi.fn(async () => undefined);
  const reaperOpen = vi.fn(async () => undefined);
  const proxyOpen = vi.fn(async () => releaseFinalResponse.promise);
  const endpoints = await Promise.all([
    startRoleEndpoint({
      path: record.locator.guardian.controlEndpoint,
      heartbeatMethod: 'guardian.heartbeat.v1',
      openMethod: 'guardian.handoff-redeem.v1',
      fields: guardianFields(record, [record.operation]),
      time: endpointTime,
      open: guardianOpen,
    }),
    startRoleEndpoint({
      path: record.locator.reaper.controlEndpoint,
      heartbeatMethod: 'reaper.heartbeat.v1',
      openMethod: 'reaper.handoff-rotate.v1',
      fields: reaperFields(record, [record.operation]),
      time: endpointTime,
      open: reaperOpen,
    }),
    startRoleEndpoint({
      path: record.locator.proxy.controlEndpoint,
      heartbeatMethod: 'control.heartbeat.v1',
      openMethod: 'handoff.redeem.v1',
      fields: proxyFields(record, mode === 'disagreement' ? [alternateOperation] : [record.operation]),
      time: endpointTime,
      open: proxyOpen,
    }),
  ]);
  const operationRegistry = new LocalOperationRegistry();
  const inheritance = createProviderProxySetInheritance({
    runtime,
    identity: {
      instanceId: randomUUID(),
      buildSetId: record.operation.buildSetId,
      flavor: 'prod',
    },
    operationRegistry,
    registerInheritedSet: () => undefined,
  });
  const harness = composeProductionStartup(record, inheritance, { runtime });
  const startup = productionStartupOutcome(harness);
  await vi.waitFor(() => expect(proxyOpen).toHaveBeenCalledOnce());
  await deadline.armed;
  deadline.fire();
  releaseFinalResponse.resolve(undefined);
  const outcome = await startup;
  const result = {
    outcome,
    fatalCalls: harness.fatals.mock.calls.length,
    openCalls: [guardianOpen.mock.calls.length, reaperOpen.mock.calls.length, proxyOpen.mock.calls.length],
    retryOwnedRows: readProviderOperationsDue(harness.db, Number.MAX_SAFE_INTEGER, 4).length,
  };
  harness.services.stopProviderOperationReconciler();
  for (const endpoint of endpoints) await endpoint.close();
  harness.db.close();
  return result;
}

async function discoveredCapsuleDeadlinePrecedenceCase(mode: 'disagreement' | 'deadline-only') {
  const record = deadlinePrecedenceRecord();
  const endpointTime = new VirtualTime();
  const scheduled = vi.spyOn(endpointTime, 'setTimeout');
  const deadline = controlledRecoveryDeadline(endpointTime);
  const runtime = { ...createRealRuntime('prod'), time: deadline.time } satisfies Runtime;
  const capsule = v3CapsuleFor(record);
  const alternateOperation = { ...record.operation, jobId: randomUUID(), operationId: randomUUID() };
  const releaseFinalResponse = deferred<void>();
  const guardianOpen = vi.fn(async () => undefined);
  const reaperOpen = vi.fn(async () => undefined);
  const proxyOpen = vi.fn(async () => releaseFinalResponse.promise);
  const endpoints = await Promise.all([
    startRoleEndpoint({
      path: record.locator.guardian.controlEndpoint,
      heartbeatMethod: 'guardian.heartbeat.v1',
      openMethod: 'guardian.handoff-redeem.v1',
      fields: guardianFields(record, [record.operation]),
      time: endpointTime,
      open: guardianOpen,
    }),
    startRoleEndpoint({
      path: record.locator.reaper.controlEndpoint,
      heartbeatMethod: 'reaper.heartbeat.v1',
      openMethod: 'reaper.handoff-rotate.v1',
      fields: reaperFields(record, [record.operation]),
      time: endpointTime,
      open: reaperOpen,
    }),
    startRoleEndpoint({
      path: record.locator.proxy.controlEndpoint,
      heartbeatMethod: 'control.heartbeat.v1',
      openMethod: 'handoff.redeem.v1',
      fields: proxyFields(record, mode === 'disagreement' ? [alternateOperation] : [record.operation]),
      time: endpointTime,
      open: proxyOpen,
    }),
  ]);
  const inheritance = createProviderProxySetInheritance({
    runtime,
    identity: {
      instanceId: randomUUID(),
      buildSetId: record.operation.buildSetId,
      flavor: 'prod',
    },
    operationRegistry: new LocalOperationRegistry(),
    registerInheritedSet: () => undefined,
  });
  const fatals = vi.fn();
  const lifecycle = lifecycleFor([], {
    time: deadline.time,
    containmentDisappeared: async () => {
      throw new Error('discovered capsule fixture has no durable claim');
    },
    redeemCapsule: (candidate, path, signal) => inheritance.redeemDiscoveredCapsule(candidate, path, signal),
    onFatal: fatals,
  });
  lifecycle.installDiscoveredCapsules(
    [{ path: '/capsules/deadline-precedence.handoff.json', capsule }],
    retainsEveryCapsule,
  );
  await vi.waitFor(() => expect(proxyOpen).toHaveBeenCalledOnce());
  await deadline.armed;
  deadline.fire();
  releaseFinalResponse.resolve(undefined);
  if (mode === 'disagreement') {
    await vi.waitFor(() => expect(fatals).toHaveBeenCalledOnce());
  } else {
    await vi.waitFor(() => expect(scheduled.mock.calls.some((call) => call[1] === 1_000)).toBe(true));
  }
  const result = {
    fatalCalls: fatals.mock.calls.length,
    openCalls: [guardianOpen.mock.calls.length, reaperOpen.mock.calls.length, proxyOpen.mock.calls.length],
    retryTimers: scheduled.mock.calls.filter((call) => call[1] === 1_000).length,
    states: lifecycle.snapshot().states,
  };
  for (const endpoint of endpoints) await endpoint.close();
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
    v3CapsuleFor(record),
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

async function terminalizationUncertaintyStartupCase(mode: 'atomic-unknown' | 'unavailable' | 'metadata') {
  const record = providerOperationRecord('executing');
  const time = new VirtualTime();
  const scheduled = vi.spyOn(time, 'setTimeout');
  const sessionId = randomUUID();
  const inheritance = {
    inheritProviderProxySet: async () => ({
      kind: 'containment-disappeared' as const,
      disappearanceReceipt: `terminalization-${mode}-proof`,
    }),
    redeemDiscoveredCapsule: async () => {
      throw new Error('capsule redemption was not expected');
    },
    proveContainmentAbsent: async () => null,
  };
  const validMetadata = {
    readStatus: () => ({
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session' as const, id: sessionId },
      sessionId,
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'tests',
      jobKind: 'provider' as const,
      phase: 'running' as const,
      updatedAt: '2026-08-09T12:34:55.000Z',
    }),
    readLaunchProjection: () => ({
      jobId: record.operation.jobId,
      owner: { kind: 'provider-session' as const, id: sessionId },
      sessionId,
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'tests',
      pool: 'default',
      enqueueSequence: 1,
      createdAt: '2026-08-09T12:34:55.000Z',
      jobKind: 'provider' as const,
      providerAction: 'exec' as const,
      request: {
        prompt: 'terminalization classification fixture',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
      },
    }),
  };
  const progressStore =
    mode === 'metadata'
      ? {}
      : {
          ...validMetadata,
          commit: () => {
            if (mode === 'unavailable') throw new ProviderOperationTerminalizationUnavailableError();
            throw new Error('atomic-terminalization-sentinel');
          },
        };
  const harness = composeProductionStartup(record, inheritance, { time, progressStore });
  const outcome = await productionStartupOutcome(harness);
  const snapshot = harness.lifecycleRef.get()?.snapshot();
  const result = {
    outcome,
    fatalCalls: harness.fatals.mock.calls.length,
    rowSurvives: readProviderOperation(harness.db, record.operation) !== null,
    slotRetained: snapshot?.states.includes('absence-delivery-pending') ?? false,
    absenceRetryIncidents:
      outcome.kind === 'fulfilled'
        ? outcome.report.incidents.filter((incident) => incident.kind === 'absence-retry-owned').length
        : 0,
    deliveryTimers: scheduled.mock.calls.filter((call) => call[1] === 1_000).length,
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

  it('retires an unmatched exact v3 capsule after independent absence proof', async () => {
    const record = providerOperationRecord('executing');
    const time = new VirtualTime();
    const scheduled = vi.spyOn(time, 'setTimeout');
    const proof = vi.fn(async () => 'exact-v3-proof');
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

    const capsule = v3CapsuleFor(record);
    lifecycle.installDiscoveredCapsules([{ path: '/capsules/startup-v3.handoff.json', capsule }], retainsEveryCapsule);
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
    lifecycle.installDiscoveredCapsules(
      [{ path: '/capsules/set-a.handoff.json', capsule: v3CapsuleFor(setA) }],
      retainsEveryCapsule,
    );
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
          fatal: isProviderProxyRecoveryFatalError(error),
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
  it('classifies terminalization uncertainty only with causal retry safety', async () => {
    const atomic = await terminalizationUncertaintyStartupCase('atomic-unknown');
    const unavailable = await terminalizationUncertaintyStartupCase('unavailable');
    const metadata = await terminalizationUncertaintyStartupCase('metadata');
    const role = await roleRecoveryStartupCase('protocol-violation');

    expect({
      atomic: {
        outcome: atomic.outcome.kind,
        fatalCalls: atomic.fatalCalls,
        rowSurvives: atomic.rowSurvives,
        slotRetained: atomic.slotRetained,
        absenceRetryIncidents: atomic.absenceRetryIncidents,
        deliveryTimers: atomic.deliveryTimers,
      },
      unavailable: {
        outcome: unavailable.outcome.kind,
        fatalCalls: unavailable.fatalCalls,
        rowSurvives: unavailable.rowSurvives,
        slotRetained: unavailable.slotRetained,
        absenceRetryIncidents: unavailable.absenceRetryIncidents,
        deliveryTimers: unavailable.deliveryTimers,
      },
      metadata: {
        outcome: metadata.outcome.kind,
        fatalCalls: metadata.fatalCalls,
        absenceRetryIncidents: metadata.absenceRetryIncidents,
        deliveryTimers: metadata.deliveryTimers,
      },
      role: {
        outcome: role.outcome.kind,
        fatalCalls: role.fatalCalls,
        retryOwned: role.dueRows.length,
      },
    }).toEqual({
      atomic: {
        outcome: 'fulfilled',
        fatalCalls: 0,
        rowSurvives: true,
        slotRetained: true,
        absenceRetryIncidents: 1,
        deliveryTimers: 1,
      },
      unavailable: {
        outcome: 'fulfilled',
        fatalCalls: 0,
        rowSurvives: true,
        slotRetained: true,
        absenceRetryIncidents: 1,
        deliveryTimers: 1,
      },
      metadata: { outcome: 'rejected', fatalCalls: 1, absenceRetryIncidents: 0, deliveryTimers: 0 },
      role: { outcome: 'rejected', fatalCalls: 1, retryOwned: 0 },
    });
  });

  it('preserves inheritance corruption after the deadline fires', async () => {
    const disagreement = await inheritanceDeadlinePrecedenceStartupCase('disagreement');
    const deadlineOnly = await inheritanceDeadlinePrecedenceStartupCase('deadline-only');

    expect({
      disagreement: {
        outcome: disagreement.outcome.kind,
        fatalCalls: disagreement.fatalCalls,
        openCalls: disagreement.openCalls,
        retryOwnedRows: disagreement.retryOwnedRows,
      },
      deadlineOnly: {
        outcome: deadlineOnly.outcome.kind,
        fatalCalls: deadlineOnly.fatalCalls,
        openCalls: deadlineOnly.openCalls,
        retryOwnedRows: deadlineOnly.retryOwnedRows,
      },
    }).toEqual({
      disagreement: {
        outcome: 'rejected',
        fatalCalls: 1,
        openCalls: [1, 1, 1],
        retryOwnedRows: 0,
      },
      deadlineOnly: {
        outcome: 'fulfilled',
        fatalCalls: 0,
        openCalls: [1, 1, 1],
        retryOwnedRows: 1,
      },
    });
  });

  it('preserves discovered capsule corruption after the deadline fires', async () => {
    const disagreement = await discoveredCapsuleDeadlinePrecedenceCase('disagreement');
    const deadlineOnly = await discoveredCapsuleDeadlinePrecedenceCase('deadline-only');

    expect({ disagreement, deadlineOnly }).toEqual({
      disagreement: {
        fatalCalls: 1,
        openCalls: [1, 1, 1],
        retryTimers: 0,
        states: ['capsule-recovering'],
      },
      deadlineOnly: {
        fatalCalls: 0,
        openCalls: [1, 1, 1],
        retryTimers: 1,
        states: ['capsule-recovering'],
      },
    });
  });

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
      lifecycleFatal: outcome.kind === 'rejected' && isProviderProxyRecoveryFatalError(outcome.error),
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
          disagreement.outcome.kind === 'rejected' && isProviderProxyRecoveryFatalError(disagreement.outcome.error),
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
          unknownUnlink.outcome.kind === 'rejected' && isProviderProxyRecoveryFatalError(unknownUnlink.outcome.error),
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
