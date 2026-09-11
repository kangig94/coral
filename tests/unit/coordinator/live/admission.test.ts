import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  LaunchCoordinator,
  LAUNCH_RECLAMATION_AGE_FLOOR_MS,
  MAX_LAUNCH_RELEASE_DIAGNOSTICS,
  MAX_SETTLED_UNBOUND_BINDINGS,
  SETTLED_UNBOUND_ABSENCE_CHECK_MS,
  SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT,
} from '#src/coordinator/live/admission.js';
import type { DurableProcessCleanup } from '#src/coordinator/live/durable-transport.js';
import type { DurableContainmentOperatorControl } from '#src/providers/cli-runner.js';
import { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import type { LaunchPermit, LaunchPool, LaunchReclamationProbeResult } from '#src/jobs/contracts/admission.js';
import type {
  ProviderOperationBindingIdentity,
  SettledUnboundStatusOwnership,
} from '#src/jobs/contracts/provider-operation-lifecycle.js';
import { canProbeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import { liveChildAuthority } from '#src/infra/process-supervision.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type {
  DurableCliProcessSubject,
  DurableContainmentStatus,
  DurableProvisionalProcessSubject,
  ProcessPort,
  Runtime,
  RuntimeSpawnOptions,
} from '#src/runtime/ports.js';
import {
  canSignalProviderHostProcessGroup,
  ProviderHostUnsupportedPlatformError,
} from '#src/providers/host-admission.js';
import { createExclusiveSpec } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

const ORIGINAL_MAX_CHILDREN = process.env.CORAL_MAX_WORKERS;
const ORIGINAL_DISCUSS_MAX_CHILDREN = process.env.CORAL_DISCUSS_MAX_WORKERS;
const TEST_PROVIDER_PID = 20_000;
const TEST_PROVIDER_INCARNATION = testIncarnation(1_700_000_000);

const PLATFORM_CAPABILITIES = {
  aix: { canProbeStartTime: false, canSignalProcessGroup: false },
  android: { canProbeStartTime: false, canSignalProcessGroup: false },
  cygwin: { canProbeStartTime: false, canSignalProcessGroup: false },
  darwin: { canProbeStartTime: true, canSignalProcessGroup: false },
  freebsd: { canProbeStartTime: false, canSignalProcessGroup: false },
  haiku: { canProbeStartTime: false, canSignalProcessGroup: false },
  linux: { canProbeStartTime: true, canSignalProcessGroup: true },
  netbsd: { canProbeStartTime: false, canSignalProcessGroup: false },
  openbsd: { canProbeStartTime: false, canSignalProcessGroup: false },
  sunos: { canProbeStartTime: false, canSignalProcessGroup: false },
  win32: { canProbeStartTime: true, canSignalProcessGroup: false },
} satisfies Record<NodeJS.Platform, { readonly canProbeStartTime: boolean; readonly canSignalProcessGroup: boolean }>;

function restoreEnv(name: 'CORAL_MAX_WORKERS' | 'CORAL_DISCUSS_MAX_WORKERS', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function testSignalAuthority(pid: number, hasExited: () => boolean, requestTermination?: () => void) {
  const child: ChildProcessLike = {
    pid,
    get exitCode() {
      return hasExited() ? 0 : null;
    },
    signalCode: null,
    stdin: null,
    stdout: null,
    stderr: null,
    on() {
      return this;
    },
    kill: () => true,
  };
  const authority = liveChildAuthority(child);
  if (authority === undefined) throw new Error('Expected test child authority.');
  return requestTermination === undefined ? authority : Object.freeze({ ...authority, requestTermination });
}

function createCoordinator(): LaunchCoordinator {
  return new LaunchCoordinator({ runtime: createRealRuntime('prod') });
}

function createProviderProcessRuntime(
  pid: number,
  groupProbeResult = true,
  platform = 'linux',
  incarnation: ProcessIncarnation | null = TEST_PROVIDER_INCARNATION,
): {
  runtime: Runtime;
  spawn: ReturnType<typeof vi.fn<ProcessPort['spawn']>>;
  childKill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
  processKill: ReturnType<typeof vi.fn<ProcessPort['kill']>>;
  observeLiveness: ReturnType<typeof vi.fn<ProcessPort['observeLiveness']>>;
  platform: ReturnType<typeof vi.fn<() => string>>;
} {
  const events = new EventEmitter();
  let processAlive = true;
  let groupAlive = groupProbeResult;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const collectChild = (signal: NodeJS.Signals): void => {
    exitCode = null;
    signalCode = signal;
    events.emit('exit', exitCode, signalCode);
    events.emit('close', exitCode, signalCode);
  };
  const childKill = vi.fn<(signal?: NodeJS.Signals) => boolean>((signal) => {
    processAlive = false;
    groupAlive = false;
    queueMicrotask(() => collectChild(signal ?? 'SIGTERM'));
    return true;
  });
  const child = {
    pid,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: events.on.bind(events),
    kill: childKill,
  } as unknown as ChildProcessLike;
  const base = createRealRuntime('prod');
  const spawn = vi.fn<ProcessPort['spawn']>((_options: RuntimeSpawnOptions) => child);
  const processKill = vi.fn<ProcessPort['kill']>((_pid, signal) => {
    if (signal === 0) return _pid < 0 ? groupAlive : processAlive;
    processAlive = false;
    groupAlive = false;
    queueMicrotask(() => collectChild(signal));
    return true;
  });
  const observeLiveness = vi.fn<ProcessPort['observeLiveness']>((targetPid) => {
    if (Math.abs(targetPid) !== pid) return 'absent';
    return (targetPid < 0 ? groupAlive : processAlive) ? 'alive' : 'absent';
  });
  const readProcessIncarnation = vi.fn<ProcessPort['readProcessIncarnation']>((targetPid) =>
    targetPid === pid && processAlive ? incarnation : null,
  );
  const observeProcessIdentities: ProcessPort['observeProcessIdentities'] = async (owners) =>
    owners.map((owner) => {
      if (observeLiveness(owner.pid) === 'absent') {
        return { owner, evidence: { kind: 'pid-absent' as const } };
      }
      const observed = readProcessIncarnation(owner.pid, platform as NodeJS.Platform);
      return observed === null
        ? { owner, evidence: { kind: 'unobservable' as const, cause: 'incarnation-unavailable' as const } }
        : { owner, evidence: { kind: 'incarnation' as const, incarnation: observed } };
    });
  const observeRecordedProcessAsync: ProcessPort['observeRecordedProcessAsync'] = async (owner) => {
    const liveness = observeLiveness(owner.pid);
    if (liveness !== 'alive') return liveness;
    const observed = readProcessIncarnation(owner.pid, platform as NodeJS.Platform);
    return observed === owner.incarnation ? 'alive' : observed === null ? 'unknown' : 'absent';
  };
  const readPlatform = vi.fn(() => platform);
  return {
    runtime: {
      ...base,
      env: { ...base.env, platform: readPlatform },
      process: {
        ...base.process,
        spawn,
        kill: processKill,
        observeLiveness,
        readProcessIncarnation,
        observeRecordedProcessAsync,
        observeProcessIdentities,
      },
    },
    spawn,
    childKill,
    processKill,
    observeLiveness,
    platform: readPlatform,
  };
}

function providerOwner(id: string) {
  return { kind: 'provider-session' as const, id };
}

function testSettledUnboundOwnership(identity: ProviderOperationBindingIdentity): SettledUnboundStatusOwnership {
  return { identity, subjects: [] } as unknown as SettledUnboundStatusOwnership;
}

describe('launch admission', () => {
  let coordinator: LaunchCoordinator;

  beforeEach(() => {
    process.env.CORAL_MAX_WORKERS = '1';
    process.env.CORAL_DISCUSS_MAX_WORKERS = '1';
    coordinator = createCoordinator();
  });

  afterEach(() => {
    restoreEnv('CORAL_MAX_WORKERS', ORIGINAL_MAX_CHILDREN);
    restoreEnv('CORAL_DISCUSS_MAX_WORKERS', ORIGINAL_DISCUSS_MAX_CHILDREN);
    vi.restoreAllMocks();
  });

  it('spawns a coordinator-local provider server detached with a verified group identity', async () => {
    const fake = createProviderProcessRuntime(TEST_PROVIDER_PID);
    const localCoordinator = new LaunchCoordinator({ runtime: fake.runtime });

    const handle = await localCoordinator.spawnProviderServer(
      {
        provider: 'codex',
        command: 'fake-codex',
        args: ['app-server'],
      },
      undefined,
      undefined,
      undefined,
      (hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }),
    );
    if ('kind' in handle) throw new Error('Expected a contained provider server handle.');

    expect(fake.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'fake-codex', args: ['app-server'], detached: true }),
    );
    expect(handle.containmentIdentity).toEqual({
      pid: TEST_PROVIDER_PID,
      incarnation: TEST_PROVIDER_INCARNATION,
      processGroupId: TEST_PROVIDER_PID,
    });
    expect(fake.observeLiveness).toHaveBeenCalledWith(-TEST_PROVIDER_PID);
    expect(fake.processKill).not.toHaveBeenCalled();
    expect(fake.platform).toHaveBeenCalled();
    expect(handle.containmentIdentity.processGroupId).toBe(handle.containmentIdentity.pid);

    await handle.close((hold) => ({
      kind: 'accepted',
      owner: 'provider-host-manager',
      settlement: hold.settled,
    }));
  });

  it.each(Object.entries(PLATFORM_CAPABILITIES))(
    'aligns coordinator-local host admission with %s platform capabilities',
    async (platform, capabilities) => {
      expect(canProbeProcessIncarnation(platform)).toBe(capabilities.canProbeStartTime);
      expect(canSignalProviderHostProcessGroup(platform)).toBe(capabilities.canSignalProcessGroup);
      const fake = createProviderProcessRuntime(TEST_PROVIDER_PID, true, platform);
      const localCoordinator = new LaunchCoordinator({ runtime: fake.runtime });
      const manager = new DefaultProviderHostManager({
        runtime: fake.runtime,
        spawnProviderServer: localCoordinator.spawnProviderServer.bind(localCoordinator),
        carrierBlocksRetirement: () => false,
      });

      const admission = manager.openSession(createExclusiveSpec({ command: 'fake-codex', args: ['app-server'] }), {
        jobId: 'job-a',
      });

      expect(fake.platform).toHaveBeenCalled();
      if (capabilities.canProbeStartTime && capabilities.canSignalProcessGroup) {
        const session = await admission;
        expect(fake.spawn).toHaveBeenCalledTimes(1);
        session.close();
      } else {
        await expect(admission).rejects.toBeInstanceOf(ProviderHostUnsupportedPlatformError);
        await expect(admission).rejects.toMatchObject({
          name: 'ProviderHostUnsupportedPlatformError',
          code: 'provider_host_platform_unsupported',
          platform,
        });
        expect(fake.spawn).not.toHaveBeenCalled();
        expect(fake.processKill).not.toHaveBeenCalled();
        expect(fake.childKill).not.toHaveBeenCalled();
      }
      await manager.shutdown();
    },
  );

  it('signals an owned coordinator-local provider group when its durable incarnation cannot be read', async () => {
    const fake = createProviderProcessRuntime(TEST_PROVIDER_PID, true, 'linux', null);
    const localCoordinator = new LaunchCoordinator({ runtime: fake.runtime });
    const manager = new DefaultProviderHostManager({
      runtime: fake.runtime,
      spawnProviderServer: localCoordinator.spawnProviderServer.bind(localCoordinator),
      carrierBlocksRetirement: () => false,
    });

    const admission = manager
      .openSession(createExclusiveSpec({ command: 'fake-codex', args: ['app-server'] }), { jobId: 'job-a' })
      .catch((error: unknown) => error);

    await expect(admission).resolves.toMatchObject({
      code: 'process_identity_unverified',
      context: { provider: 'codex', pid: TEST_PROVIDER_PID },
    });
    expect(fake.processKill).toHaveBeenCalledWith(-TEST_PROVIDER_PID, 'SIGTERM');
    expect(fake.childKill).not.toHaveBeenCalled();
    expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
    expect([...manager.admissionSnapshot().state.values()].some((entry) => entry.phase === 'live')).toBe(false);
    expect(manager.listProviderHosts().some((entry) => entry.status === 'live')).toBe(false);
    await manager.shutdown();
  }, 30_000);

  it('signals an owned coordinator-local provider group when reading its durable incarnation throws', async () => {
    const fake = createProviderProcessRuntime(TEST_PROVIDER_PID);
    const runtime: Runtime = {
      ...fake.runtime,
      process: {
        ...fake.runtime.process,
        readProcessIncarnation: () => {
          throw new Error('synthetic process read failure');
        },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const manager = new DefaultProviderHostManager({
      runtime,
      spawnProviderServer: localCoordinator.spawnProviderServer.bind(localCoordinator),
      carrierBlocksRetirement: () => false,
    });

    const admission = manager
      .openSession(createExclusiveSpec({ command: 'fake-codex', args: ['app-server'] }), { jobId: 'job-a' })
      .catch((error: unknown) => error);

    await expect(admission).resolves.toMatchObject({
      code: 'process_identity_unverified',
      context: { provider: 'codex', pid: TEST_PROVIDER_PID },
    });
    expect(fake.processKill).toHaveBeenCalledWith(-TEST_PROVIDER_PID, 'SIGTERM');
    expect(fake.childKill).not.toHaveBeenCalled();
    expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
    expect([...manager.admissionSnapshot().state.values()].some((entry) => entry.phase === 'live')).toBe(false);
    expect(manager.listProviderHosts().some((entry) => entry.status === 'live')).toBe(false);
    await manager.shutdown();
  }, 30_000);

  it('accepts observed group absence when a coordinator-local provider process-group probe fails', async () => {
    const fake = createProviderProcessRuntime(TEST_PROVIDER_PID, false);
    const localCoordinator = new LaunchCoordinator({ runtime: fake.runtime });
    const manager = new DefaultProviderHostManager({
      runtime: fake.runtime,
      spawnProviderServer: localCoordinator.spawnProviderServer.bind(localCoordinator),
      carrierBlocksRetirement: () => false,
    });

    await expect(
      manager.openSession(createExclusiveSpec({ command: 'fake-codex', args: ['app-server'] }), { jobId: 'job-a' }),
    ).rejects.toMatchObject({
      code: 'process_identity_unverified',
      message: expect.stringContaining('has no attributable live process group'),
      context: { provider: 'codex', pid: TEST_PROVIDER_PID },
    });
    expect(fake.observeLiveness).toHaveBeenCalledWith(-TEST_PROVIDER_PID);
    expect(fake.processKill).not.toHaveBeenCalled();
    expect(fake.childKill).not.toHaveBeenCalled();
    expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
    expect([...manager.admissionSnapshot().state.values()].some((entry) => entry.phase === 'live')).toBe(false);
    expect(manager.listProviderHosts().some((entry) => entry.status === 'live')).toBe(false);
    await manager.shutdown();
  });

  it('returns an admitted outcome when capacity is available', () => {
    const admission = coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'), 'default');
    expect(admission).toMatchObject({ type: 'immediate' });
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected immediate permit');
    expect(admission.permit).toMatchObject({
      jobId: 'job-1',
      pool: 'default',
      provider: 'codex',
      holder: { kind: 'local-execution' },
    });
    expect(admission.permit.reservationId).not.toBe('');
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queuePosition('job-1', 'default')).toBeNull();
  });

  it('fails closed for a runtime pool value outside the exhaustive LaunchPool set', async () => {
    const invalidPool = 'unknown-pool' as LaunchPool;
    const invariantMessage = 'Launch admission invariant violated: unknown pool "unknown-pool".';
    const valid = coordinator.requestLaunch('valid', 'codex', providerOwner('valid-session'), 'default');
    if (valid === 'queue_full' || valid.type !== 'immediate') throw new Error('expected immediate permit');
    const invalidPermit = { ...valid.permit, pool: invalidPool } satisfies LaunchPermit;

    expect(() => coordinator.requestLaunch('intruder', 'codex', providerOwner('session'), invalidPool)).toThrow(
      invariantMessage,
    );
    expect(() => coordinator.releaseLaunch(invalidPermit)).toThrow(invariantMessage);
    expect(() => coordinator.queueDepth(invalidPool)).toThrow(invariantMessage);
    expect(() => coordinator.queuePosition('intruder', invalidPool)).toThrow(invariantMessage);
    expect(() => coordinator.getActiveJobIds(invalidPool)).toThrow(invariantMessage);
    await expect(
      coordinator.spawnDurableJob({
        provider: 'codex',
        command: 'never-spawned',
        args: [],
        jobDir: '/never-created',
        pool: invalidPool,
      }),
    ).rejects.toThrow(invariantMessage);
    expect(coordinator.active).toBe(1);
    expect(coordinator.queueDepth()).toBe(0);
  });

  it('returns a queued outcome with the current position when capacity is full', () => {
    expect(coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'), 'default')).toMatchObject({
      type: 'immediate',
    });

    const queued = coordinator.requestLaunch('job-2', 'codex', providerOwner('session-2'), 'default');

    expect(queued).not.toBe('queue_full');
    expect(queued).toMatchObject({
      type: 'queued',
      queuePosition: 1,
    });
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queuePosition('job-2', 'default')).toBe(1);
  });

  it('describes active and queued reservations without exposing release authority', () => {
    const active = coordinator.requestLaunch('active-view', 'codex', providerOwner('active-session'), 'default');
    if (active === 'queue_full' || active.type !== 'immediate') throw new Error('expected active reservation');
    const queued = coordinator.requestLaunch('queued-view', 'claude', providerOwner('queued-session'), 'default');
    if (queued === 'queue_full' || queued.type !== 'queued') throw new Error('expected queued reservation');

    const activeView = coordinator.reservationFor('active-view');
    expect(activeView).toMatchObject({
      kind: 'active',
      pool: 'default',
      provider: 'codex',
      executionOwner: providerOwner('active-session'),
      holder: { kind: 'local-execution' },
      heldForMs: expect.any(Number),
    });
    expect(activeView).not.toHaveProperty('permit');
    expect(activeView).not.toHaveProperty('reservationId');

    const queuedView = coordinator.reservationFor('queued-view');
    expect(queuedView).toEqual({
      kind: 'queued',
      reservationId: expect.any(String),
      pool: 'default',
      provider: 'claude',
      executionOwner: providerOwner('queued-session'),
      position: 1,
    });
    expect(queuedView).not.toHaveProperty('permit');
  });

  it('rejects duplicate job ids without exposing or mutating the incumbent reservation', async () => {
    const active = coordinator.requestLaunch('active', 'codex', providerOwner('session-active'), 'default');
    expect(active).toMatchObject({
      type: 'immediate',
    });
    if (active === 'queue_full' || active.type !== 'immediate') throw new Error('expected active reservation');
    const queued = coordinator.requestLaunch('queued', 'codex', providerOwner('session-queued'), 'default');
    if (queued === 'queue_full' || queued.type !== 'queued') throw new Error('expected queued reservation');

    expect(() => coordinator.requestLaunch('active', 'claude', providerOwner('intruder-active'), 'discuss')).toThrow(
      /reservation already exists for job active/u,
    );
    expect(() => coordinator.requestLaunch('queued', 'claude', providerOwner('intruder-queued'), 'discuss')).toThrow(
      /reservation already exists for job queued/u,
    );

    expect(coordinator.getActiveJobIds()).toEqual(['active']);
    expect(coordinator.queuePosition('queued', 'default')).toBe(1);
    expect(coordinator.getActiveJobIds('discuss')).toEqual([]);
    expect(coordinator.queueDepth('discuss')).toBe(0);

    const permit = queued.waitForPermit();
    coordinator.releaseLaunch(active.permit);
    await permit;
    expect(coordinator.getActiveJobIds()).toEqual(['queued']);
  });

  it('tracks default and discuss pools independently', async () => {
    const defaultAdmission = coordinator.requestLaunch(
      'default-1',
      'codex',
      providerOwner('default-session-1'),
      'default',
    );
    expect(defaultAdmission).toMatchObject({
      type: 'immediate',
    });
    const discussAdmission = coordinator.requestLaunch(
      'discuss-1',
      'codex',
      { kind: 'discussion', id: 'discussion-1' },
      'discuss',
    );
    expect(discussAdmission).toMatchObject({ type: 'immediate' });
    if (defaultAdmission === 'queue_full' || defaultAdmission.type !== 'immediate') {
      throw new Error('expected immediate default permit');
    }
    if (discussAdmission === 'queue_full' || discussAdmission.type !== 'immediate') {
      throw new Error('expected immediate discuss permit');
    }

    const queuedDefault = coordinator.requestLaunch(
      'default-2',
      'codex',
      providerOwner('default-session-2'),
      'default',
    );
    const queuedDiscuss = coordinator.requestLaunch(
      'discuss-2',
      'codex',
      { kind: 'discussion', id: 'discussion-1' },
      'discuss',
    );

    expect(queuedDefault).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(queuedDiscuss).toMatchObject({ type: 'queued', queuePosition: 1 });

    if (queuedDefault === 'queue_full' || queuedDefault.type !== 'queued') throw new Error('expected queued default');
    if (queuedDiscuss === 'queue_full' || queuedDiscuss.type !== 'queued') throw new Error('expected queued discuss');

    const defaultPermit = queuedDefault.waitForPermit();
    const discussPermit = queuedDiscuss.waitForPermit();

    coordinator.releaseLaunch(defaultAdmission.permit);
    await defaultPermit;
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queueDepth('discuss')).toBe(1);

    coordinator.releaseLaunch(discussAdmission.permit);
    await discussPermit;
    expect(coordinator.queueDepth('discuss')).toBe(0);
    expect(coordinator.getActiveJobIds()).toEqual(['default-2']);
    expect(coordinator.getActiveJobIds('discuss')).toEqual(['discuss-2']);
  });

  it('returns queue_full when the internal queue limit is reached', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'), 'default')).toMatchObject({
      type: 'immediate',
    });

    for (let i = 2; i <= 21; i += 1) {
      const result = coordinator.requestLaunch(`job-${i}`, 'codex', providerOwner(`session-${i}`), 'default');
      expect(result).not.toBe('queue_full');
      if (result !== 'queue_full' && result.type === 'queued') {
        void result.waitForPermit().catch(() => null);
      }
    }

    expect(coordinator.queueDepth()).toBe(20);
    expect(coordinator.requestLaunch('job-22', 'codex', providerOwner('session-22'), 'default')).toBe('queue_full');
    await coordinator.terminateAll();
  });

  it('admits queued jobs in strict FIFO order when a launch is released', async () => {
    const first = coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'), 'default');
    expect(first).toMatchObject({
      type: 'immediate',
    });
    if (first === 'queue_full' || first.type !== 'immediate') throw new Error('expected immediate permit');
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex', providerOwner('session-2'), 'default');
    const queuedThird = coordinator.requestLaunch('job-3', 'codex', providerOwner('session-3'), 'default');

    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    let thirdGranted = false;
    const secondPermit = queuedSecond.waitForPermit();
    const thirdPermit = queuedThird.waitForPermit().then(() => {
      thirdGranted = true;
    });

    coordinator.releaseLaunch(first.permit);
    const admittedSecond = await secondPermit;
    await Promise.resolve();

    expect(thirdGranted).toBe(false);
    expect(coordinator.queuePosition('job-3', 'default')).toBe(1);

    coordinator.releaseLaunch(admittedSecond);
    await thirdPermit;
    expect(thirdGranted).toBe(true);
    expect(coordinator.queueDepth()).toBe(0);
  });

  it('queued-handle cancellation rejects the queued permit and advances the queue head', async () => {
    const first = coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'), 'default');
    expect(first).toMatchObject({
      type: 'immediate',
    });
    if (first === 'queue_full' || first.type !== 'immediate') throw new Error('expected immediate permit');
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex', providerOwner('session-2'), 'default');
    const queuedThird = coordinator.requestLaunch('job-3', 'codex', providerOwner('session-3'), 'default');

    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    const rejected = queuedSecond.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(queuedSecond.cancel()).toEqual({ kind: 'cancelled' });
    expect((await rejected)?.message).toBe('Launch canceled while queued');

    const thirdPermit = queuedThird.waitForPermit();
    coordinator.releaseLaunch(first.permit);
    await thirdPermit;
    expect(coordinator.queuePosition('job-3', 'default')).toBeNull();
  });

  it('observes a recovered queue cancellation before a waiter attaches', async () => {
    coordinator.restoreActiveLaunch('blocker', 'codex', providerOwner('blocker-session'), 'default');
    const restored = coordinator.restoreQueuedLaunch(
      'recovered',
      'codex',
      providerOwner('recovered-session'),
      'default',
    );
    const unhandled: unknown[] = [];
    const observeUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', observeUnhandled);

    try {
      expect(restored.cancel()).toEqual({ kind: 'cancelled' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await expect(restored.waitForPermit()).rejects.toThrow('Launch canceled while queued');
    } finally {
      process.off('unhandledRejection', observeUnhandled);
    }
  });

  it('binds queued-handle cancellation to its exact reservation generation', async () => {
    const firstBlocker = coordinator.requestLaunch('blocker-1', 'codex', providerOwner('blocker-session-1'), 'default');
    if (firstBlocker === 'queue_full' || firstBlocker.type !== 'immediate') throw new Error('expected blocker');
    const staleHandle = coordinator.requestLaunch('reused-job', 'codex', providerOwner('old-session'), 'default');
    if (staleHandle === 'queue_full' || staleHandle.type !== 'queued') throw new Error('expected old queued handle');
    coordinator.releaseLaunch(firstBlocker.permit);
    const stalePermit = await staleHandle.waitForPermit();
    coordinator.releaseLaunch(stalePermit);

    const secondBlocker = coordinator.requestLaunch(
      'blocker-2',
      'codex',
      providerOwner('blocker-session-2'),
      'default',
    );
    if (secondBlocker === 'queue_full' || secondBlocker.type !== 'immediate') throw new Error('expected blocker');
    const currentHandle = coordinator.requestLaunch('reused-job', 'codex', providerOwner('new-session'), 'default');
    if (currentHandle === 'queue_full' || currentHandle.type !== 'queued') {
      throw new Error('expected current queued handle');
    }

    expect(staleHandle.cancel()).toEqual({ kind: 'admitted', permit: stalePermit });
    expect(coordinator.queuePosition('reused-job', 'default')).toBe(1);

    const permit = currentHandle.waitForPermit();
    coordinator.releaseLaunch(secondBlocker.permit);
    await permit;
    expect(coordinator.getActiveJobIds()).toEqual(['reused-job']);
  });

  it('restores active and queued launches for recovery bookkeeping', async () => {
    const restoredDefault = coordinator.restoreActiveLaunch(
      'default-1',
      'codex',
      providerOwner('default-session-1'),
      'default',
    );
    coordinator.restoreActiveLaunch('discuss-1', 'codex', { kind: 'discussion', id: 'discussion-1' }, 'discuss');
    expect(coordinator.active).toBe(2);

    const restored = coordinator.restoreQueuedLaunch('queued-1', 'codex', providerOwner('queued-session-1'), 'default');
    expect(restored).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(coordinator.queueDepth()).toBe(1);

    const permit = restored.waitForPermit();
    coordinator.releaseLaunch(restoredDefault);
    await permit;
    expect(coordinator.getActiveJobIds('default')).toContain('queued-1');
  });

  it('does not type job evidence as proxy-shaped reclamation authorization', () => {
    const jobEvidence = { kind: 'job-terminal', phase: 'completed' } as const;

    expectTypeOf(jobEvidence).not.toMatchTypeOf<LaunchReclamationProbeResult<'proxy-operation'>>();
    expectTypeOf(jobEvidence).not.toMatchTypeOf<LaunchReclamationProbeResult<'undecided-provider-operation'>>();
  });

  it('reclaims a terminal proxy permit only with exact operation absence evidence', async () => {
    let now = 10_000;
    const base = createRealRuntime('prod');
    const localCoordinator = new LaunchCoordinator({
      runtime: { ...base, time: { ...base.time, now: () => now } },
    });
    localCoordinator.connectLaunchReclamationOracle('proxy-operation', () => ({
      kind: 'provider-operation-absent',
      operationId: 'different-operation',
      jobEvidence: { kind: 'job-terminal', phase: 'completed' },
    }));
    const ended = localCoordinator.requestLaunch('ended-job', 'codex', providerOwner('ended-session'), 'default');
    if (ended === 'queue_full' || ended.type !== 'immediate') throw new Error('expected ended permit');
    const identity = { jobId: ended.permit.jobId, operationId: 'ended-operation' };
    expect(localCoordinator.prepareProviderOperationBinding(ended.permit, identity)).toEqual({ kind: 'prepared' });
    const binding = localCoordinator.commitProviderOperationBinding(identity);
    if (binding.kind !== 'bound') throw new Error('expected proxy permit');
    const waiting = localCoordinator.requestLaunch('waiting-job', 'codex', providerOwner('waiting-session'), 'default');
    if (waiting === 'queue_full' || waiting.type !== 'queued') throw new Error('expected queued permit');

    now += LAUNCH_RECLAMATION_AGE_FLOOR_MS;
    localCoordinator.sweepStaleLaunchPermits();
    expect(localCoordinator.reservationFor(ended.permit.jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'proxy-operation', operationId: identity.operationId },
    });
    expect(localCoordinator.queuePosition('waiting-job', 'default')).toBe(1);
    expect(localCoordinator.launchReclamationDiagnostics()).toEqual([]);

    localCoordinator.connectLaunchReclamationOracle('proxy-operation', (permit) => ({
      kind: 'provider-operation-absent',
      operationId: permit.holder.operationId,
      jobEvidence: { kind: 'job-terminal', phase: 'completed' },
    }));
    localCoordinator.sweepStaleLaunchPermits();
    const admitted = await waiting.waitForPermit();

    expect(localCoordinator.active).toBe(1);
    expect(localCoordinator.reservationFor(ended.permit.jobId)).toBeNull();
    expect(localCoordinator.reservationFor(admitted.jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'local-execution' },
    });
    expect(localCoordinator.launchReclamationDiagnostics()).toEqual([
      expect.objectContaining({
        reservationId: ended.permit.reservationId,
        jobId: ended.permit.jobId,
        holder: { kind: 'proxy-operation', operationId: identity.operationId },
        heldForMs: LAUNCH_RECLAMATION_AGE_FLOOR_MS,
        evidence: {
          kind: 'provider-operation-absent',
          operationId: identity.operationId,
          jobEvidence: { kind: 'job-terminal', phase: 'completed' },
        },
      }),
    ]);
  });

  it('does not reclaim a young permit during the reserve-before-journal window', () => {
    let now = 20_000;
    const base = createRealRuntime('prod');
    const localCoordinator = new LaunchCoordinator({
      runtime: { ...base, time: { ...base.time, now: () => now } },
    });
    localCoordinator.connectLaunchReclamationOracle('local-execution', () => ({ kind: 'job-absent' }));
    const starting = localCoordinator.requestLaunch(
      'starting-job',
      'codex',
      providerOwner('starting-session'),
      'default',
    );
    if (starting === 'queue_full' || starting.type !== 'immediate') throw new Error('expected starting permit');

    now += LAUNCH_RECLAMATION_AGE_FLOOR_MS - 1;
    localCoordinator.sweepStaleLaunchPermits();

    expect(localCoordinator.active).toBe(1);
    expect(localCoordinator.reservationFor(starting.permit.jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'local-execution' },
    });
    expect(localCoordinator.launchReclamationDiagnostics()).toEqual([]);

    now += 1;
    localCoordinator.sweepStaleLaunchPermits();

    expect(localCoordinator.active).toBe(0);
    expect(localCoordinator.reservationFor(starting.permit.jobId)).toBeNull();
    expect(localCoordinator.launchReclamationDiagnostics()).toEqual([
      expect.objectContaining({
        reservationId: starting.permit.reservationId,
        holder: { kind: 'local-execution' },
        evidence: { kind: 'job-absent' },
      }),
    ]);
  });

  it('retains queue-handoff permits after the reclamation age floor', () => {
    let now = 22_000;
    const base = createRealRuntime('prod');
    const localCoordinator = new LaunchCoordinator({
      runtime: { ...base, time: { ...base.time, now: () => now } },
    });
    const blocker = localCoordinator.requestLaunch(
      'queue-handoff-blocker',
      'codex',
      providerOwner('queue-handoff-blocker-session'),
      'default',
    );
    const queued = localCoordinator.requestLaunch(
      'unregistered-holder',
      'codex',
      providerOwner('unregistered-holder-session'),
      'default',
    );
    if (blocker === 'queue_full' || blocker.type !== 'immediate') throw new Error('expected blocker permit');
    if (queued === 'queue_full' || queued.type !== 'queued') throw new Error('expected queued reservation');

    expect(localCoordinator.releaseLaunch(blocker.permit)).toMatchObject({ kind: 'released' });
    now += LAUNCH_RECLAMATION_AGE_FLOOR_MS;
    localCoordinator.sweepStaleLaunchPermits();

    expect(localCoordinator.reservationFor('unregistered-holder')).toMatchObject({
      kind: 'active',
      holder: { kind: 'queue-handoff' },
    });
    expect(localCoordinator.launchReclamationDiagnostics()).toEqual([]);
    const cancellation = queued.cancel();
    if (cancellation.kind !== 'admitted') throw new Error('expected queue handoff permit');
    expect(localCoordinator.releaseLaunch(cancellation.permit)).toMatchObject({ kind: 'released' });
  });

  it('retains undecided provider-operation ownership until every named record is absent', async () => {
    let now = 25_000;
    const base = createRealRuntime('prod');
    const localCoordinator = new LaunchCoordinator({
      runtime: { ...base, time: { ...base.time, now: () => now } },
    });
    const recordKeys = ['provider-operation-record-1', 'provider-operation-record-2'];
    const presentRecords = new Set(recordKeys);
    const held = localCoordinator.restoreActiveLaunch(
      'ambiguous-job',
      'codex',
      providerOwner('ambiguous-session'),
      'default',
      { kind: 'undecided-provider-operation', recordKeys },
    );
    expect(localCoordinator.reclaimLaunchPermit(held)).toBe(false);
    localCoordinator.connectLaunchReclamationOracle('undecided-provider-operation', () => {
      throw new Error('record journal unavailable');
    });
    expect(localCoordinator.reclaimLaunchPermit(held)).toBe(false);
    localCoordinator.connectLaunchReclamationOracle('undecided-provider-operation', (permit) =>
      permit.holder.recordKeys.some((key) => presentRecords.has(key))
        ? { kind: 'job-live' }
        : {
            kind: 'provider-operation-records-absent',
            recordKeys: permit.holder.recordKeys,
            jobEvidence: { kind: 'job-terminal', phase: 'completed' },
          },
    );
    const waiting = localCoordinator.requestLaunch(
      'post-ambiguity',
      'codex',
      providerOwner('post-ambiguity-session'),
      'default',
    );
    if (waiting === 'queue_full' || waiting.type !== 'queued') throw new Error('expected queued permit');

    now += LAUNCH_RECLAMATION_AGE_FLOOR_MS;
    localCoordinator.sweepStaleLaunchPermits();
    presentRecords.delete(recordKeys[0] ?? '');
    localCoordinator.sweepStaleLaunchPermits();

    expect(localCoordinator.reservationFor(held.jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'undecided-provider-operation', recordKeys },
    });
    expect(localCoordinator.queuePosition('post-ambiguity', 'default')).toBe(1);

    presentRecords.clear();
    localCoordinator.sweepStaleLaunchPermits();
    const admitted = await waiting.waitForPermit();

    expect(localCoordinator.reservationFor(held.jobId)).toBeNull();
    expect(admitted.jobId).toBe('post-ambiguity');
    expect(localCoordinator.launchReclamationDiagnostics()).toEqual([
      expect.objectContaining({
        reservationId: held.reservationId,
        holder: { kind: 'undecided-provider-operation', recordKeys },
        evidence: {
          kind: 'provider-operation-records-absent',
          recordKeys,
          jobEvidence: { kind: 'job-terminal', phase: 'completed' },
        },
      }),
    ]);
  });

  it('retains permits when an oracle throws or a holder kind has no registered oracle', () => {
    let now = 30_000;
    const base = createRealRuntime('prod');
    const localCoordinator = new LaunchCoordinator({
      runtime: { ...base, time: { ...base.time, now: () => now } },
    });
    localCoordinator.connectLaunchReclamationOracle('local-execution', (permit) => {
      const jobId = permit.jobId;
      if (jobId === 'unreadable-job') throw new Error('journal unavailable');
      return { kind: 'job-terminal', phase: 'aborted' };
    });
    const unreadable = localCoordinator.requestLaunch(
      'unreadable-job',
      'codex',
      providerOwner('unreadable-session'),
      'default',
    );
    const proxySource = localCoordinator.requestLaunch('proxy-job', 'codex', providerOwner('proxy-session'), 'discuss');
    if (unreadable === 'queue_full' || unreadable.type !== 'immediate') throw new Error('expected unreadable permit');
    if (proxySource === 'queue_full' || proxySource.type !== 'immediate') throw new Error('expected proxy source');
    const identity = { jobId: proxySource.permit.jobId, operationId: 'unconnected-operation' };
    expect(localCoordinator.prepareProviderOperationBinding(proxySource.permit, identity)).toEqual({
      kind: 'prepared',
    });
    const binding = localCoordinator.commitProviderOperationBinding(identity);
    if (binding.kind !== 'bound') throw new Error('expected proxy permit');

    now += LAUNCH_RECLAMATION_AGE_FLOOR_MS;
    localCoordinator.sweepStaleLaunchPermits();

    expect(localCoordinator.active).toBe(2);
    expect(localCoordinator.reservationFor(unreadable.permit.jobId)).toMatchObject({ kind: 'active' });
    expect(localCoordinator.reservationFor(binding.successorPermit.jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'proxy-operation', operationId: identity.operationId },
    });
    expect(localCoordinator.launchReclamationDiagnostics()).toEqual([]);
  });

  it('never reclaims a permit for a live job', () => {
    let now = 40_000;
    const base = createRealRuntime('prod');
    const localCoordinator = new LaunchCoordinator({
      runtime: { ...base, time: { ...base.time, now: () => now } },
    });
    localCoordinator.connectLaunchReclamationOracle('local-execution', () => ({ kind: 'job-live' }));
    const live = localCoordinator.requestLaunch('live-job', 'codex', providerOwner('live-session'), 'default');
    if (live === 'queue_full' || live.type !== 'immediate') throw new Error('expected live permit');

    now += LAUNCH_RECLAMATION_AGE_FLOOR_MS * 2;
    localCoordinator.sweepStaleLaunchPermits();

    expect(localCoordinator.active).toBe(1);
    expect(localCoordinator.reservationFor(live.permit.jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'local-execution' },
    });
    expect(localCoordinator.launchReclamationDiagnostics()).toEqual([]);
  });

  it('fences a reused job id from a stale permit', () => {
    const first = coordinator.requestLaunch('reused', 'codex', providerOwner('first'), 'default');
    if (first === 'queue_full' || first.type !== 'immediate') throw new Error('expected first permit');
    expect(coordinator.releaseLaunch(first.permit)).toEqual({
      kind: 'released',
      pool: 'default',
      admittedNext: false,
    });

    const second = coordinator.requestLaunch('reused', 'codex', providerOwner('second'), 'default');
    if (second === 'queue_full' || second.type !== 'immediate') throw new Error('expected second permit');
    expect(second.permit.reservationId).not.toBe(first.permit.reservationId);
    expect(coordinator.releaseLaunch(first.permit)).toEqual({ kind: 'already-released', pool: 'default' });
    expect(coordinator.reservationFor('reused')).toMatchObject({
      kind: 'active',
      executionOwner: providerOwner('second'),
    });
  });

  it('rejects a synthetic durable reservation that collides across pools', async () => {
    const base = createRealRuntime('prod');
    const uuid = vi.fn().mockReturnValueOnce('existing-reservation').mockReturnValueOnce('collision');
    const localCoordinator = new LaunchCoordinator({ runtime: { ...base, ids: { ...base.ids, uuid } } });
    const existing = localCoordinator.requestLaunch(
      'spawndurable-collision',
      'codex',
      { kind: 'discussion', id: 'collision-discussion' },
      'discuss',
    );
    if (existing === 'queue_full' || existing.type !== 'immediate') throw new Error('expected existing reservation');

    await expect(
      localCoordinator.spawnDurableJob({
        provider: 'codex',
        command: 'never-spawned',
        args: [],
        jobDir: '/never-created',
        pool: 'default',
      }),
    ).rejects.toThrow(/reservation already exists for job spawndurable-collision in pool discuss/u);
    expect(localCoordinator.reservationFor('spawndurable-collision')).toMatchObject({
      kind: 'active',
      pool: 'discuss',
    });
  });

  it('binds and settles a proxy operation with a successor permit', () => {
    const admission = coordinator.requestLaunch('job-proxy', 'codex', providerOwner('session-proxy'), 'default');
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected source permit');
    const identity = { jobId: 'job-proxy', operationId: 'operation-proxy' };

    expect(coordinator.prepareProviderOperationBinding(admission.permit, identity)).toEqual({ kind: 'prepared' });
    const binding = coordinator.commitProviderOperationBinding(identity);
    expect(binding).toMatchObject({
      kind: 'bound',
      successorPermit: {
        reservationId: admission.permit.reservationId,
        holder: { kind: 'proxy-operation', operationId: 'operation-proxy' },
      },
    });
    if (binding.kind !== 'bound') throw new Error('expected bound operation');
    expect(coordinator.releaseLaunch(admission.permit)).toEqual({
      kind: 'transferred',
      pool: 'default',
      holder: { kind: 'proxy-operation', operationId: 'operation-proxy' },
    });
    expect(coordinator.launchReleaseDiagnostics()).toEqual([
      {
        reservationId: admission.permit.reservationId,
        jobId: admission.permit.jobId,
        pool: 'default',
        provider: 'codex',
        attemptedHolder: { kind: 'local-execution' },
        disposition: {
          kind: 'transferred',
          pool: 'default',
          holder: { kind: 'proxy-operation', operationId: 'operation-proxy' },
        },
        observedAtMs: expect.any(Number),
      },
    ]);
    expect(coordinator.settleProviderOperationBinding(identity)).toMatchObject({
      kind: 'settled',
      reservationId: admission.permit.reservationId,
    });
    expect(coordinator.releaseLaunch(binding.successorPermit)).toEqual({
      kind: 'already-released',
      pool: 'default',
    });
  });

  it('distinguishes source transfer from releasing the successor permit', () => {
    const admission = coordinator.requestLaunch(
      'job-successor',
      'codex',
      providerOwner('session-successor'),
      'default',
    );
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected source permit');
    const identity = { jobId: 'job-successor', operationId: 'operation-successor' };

    expect(coordinator.prepareProviderOperationBinding(admission.permit, identity)).toEqual({ kind: 'prepared' });
    const binding = coordinator.commitProviderOperationBinding(identity);
    if (binding.kind !== 'bound') throw new Error('expected successor permit');

    expect(coordinator.releaseLaunch(admission.permit)).toEqual({
      kind: 'transferred',
      pool: 'default',
      holder: { kind: 'proxy-operation', operationId: identity.operationId },
    });
    expect(coordinator.releaseLaunch(binding.successorPermit)).toEqual({
      kind: 'released',
      pool: 'default',
      admittedNext: false,
    });
    expect(coordinator.releaseLaunch(binding.successorPermit)).toEqual({ kind: 'already-released', pool: 'default' });
    expect(coordinator.releaseLaunch(admission.permit)).toEqual({ kind: 'already-released', pool: 'default' });
  });

  it('bounds non-release diagnostics by reservation identity', () => {
    let evictedReservationId = '';
    for (let index = 0; index <= MAX_LAUNCH_RELEASE_DIAGNOSTICS; index += 1) {
      const admission = coordinator.requestLaunch(
        `diagnostic-${index}`,
        'codex',
        providerOwner(`diagnostic-session-${index}`),
        'default',
      );
      if (admission === 'queue_full' || admission.type !== 'immediate') {
        throw new Error('expected diagnostic source permit');
      }
      coordinator.releaseLaunch(admission.permit);
      coordinator.releaseLaunch(admission.permit);
      if (index === 0) evictedReservationId = admission.permit.reservationId;
    }

    const diagnostics = coordinator.launchReleaseDiagnostics();
    expect(diagnostics).toHaveLength(MAX_LAUNCH_RELEASE_DIAGNOSTICS);
    expect(diagnostics.some(({ reservationId }) => reservationId === evictedReservationId)).toBe(false);
    expect(diagnostics.at(-1)).toMatchObject({
      jobId: `diagnostic-${MAX_LAUNCH_RELEASE_DIAGNOSTICS}`,
      disposition: { kind: 'already-released' },
    });
  });

  it('commutes settlement before preparation without inventing a reservation id', () => {
    const identity = { jobId: 'job-early-settlement', operationId: 'operation-early-settlement' };
    expect(coordinator.settleProviderOperationBinding(identity)).toEqual({ kind: 'settled-unbound' });

    const admission = coordinator.requestLaunch(
      identity.jobId,
      'codex',
      providerOwner('session-early-settlement'),
      'default',
    );
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected source permit');
    expect(coordinator.prepareProviderOperationBinding(admission.permit, identity)).toEqual({
      kind: 'already-settled',
    });
    expect(coordinator.reservationFor(identity.jobId)).toBeNull();
    expect(coordinator.commitProviderOperationBinding(identity)).toEqual({ kind: 'already-settled' });
  });

  it('retires an unknown settlement after journal absence is established', async () => {
    vi.useFakeTimers();
    try {
      coordinator.connectProviderOperationBindingJournal(() => ({ kind: 'absent' }));
      const identity = { jobId: 'job-absent-settlement', operationId: 'operation-absent-settlement' };
      const statuses = new Set([`${identity.jobId}:${identity.operationId}`]);
      coordinator.connectSettledUnboundStatus({
        rebind: () => null,
        record: (settled) => ({ kind: 'recorded', ownership: testSettledUnboundOwnership(settled) }),
        clear: (settled) => statuses.delete(`${settled.jobId}:${settled.operationId}`),
        clearAbsent: (settled) => statuses.delete(`${settled.jobId}:${settled.operationId}`),
        clearRefusal: () => {},
      });
      expect(coordinator.settleProviderOperationBinding(identity)).toEqual({ kind: 'settled-unbound' });

      await vi.advanceTimersByTimeAsync(SETTLED_UNBOUND_ABSENCE_CHECK_MS);
      expect(statuses).toEqual(new Set());
      const admission = coordinator.requestLaunch(
        identity.jobId,
        'codex',
        providerOwner('session-after-absence'),
        'default',
      );
      if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected source permit');
      expect(coordinator.prepareProviderOperationBinding(admission.permit, identity)).toEqual({ kind: 'prepared' });
      expect(coordinator.releaseLaunch(admission.permit)).toMatchObject({ kind: 'released' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves persistently unknown settlement evidence to a durable successor until preparation consumes it', async () => {
    vi.useFakeTimers();
    try {
      const statuses = new Set<string>();
      coordinator.connectProviderOperationBindingJournal(() => ({
        kind: 'unknown',
        reason: 'journal unavailable',
      }));
      coordinator.connectSettledUnboundStatus({
        rebind: () => null,
        record: (identity) => {
          statuses.add(`${identity.jobId}:${identity.operationId}`);
          return { kind: 'recorded', ownership: testSettledUnboundOwnership(identity) };
        },
        clear: (identity) => statuses.delete(`${identity.jobId}:${identity.operationId}`),
        clearAbsent: (identity) => statuses.delete(`${identity.jobId}:${identity.operationId}`),
        clearRefusal: () => {},
      });
      const identity = { jobId: 'job-unknown-settlement', operationId: 'operation-unknown-settlement' };

      expect(coordinator.settleProviderOperationBinding(identity)).toEqual({ kind: 'settled-unbound' });
      await vi.advanceTimersByTimeAsync(SETTLED_UNBOUND_ABSENCE_CHECK_MS * SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT);
      expect(statuses).toEqual(new Set([`${identity.jobId}:${identity.operationId}`]));

      const admission = coordinator.requestLaunch(
        identity.jobId,
        'codex',
        providerOwner('session-after-unknown'),
        'default',
      );
      if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected source permit');
      expect(coordinator.prepareProviderOperationBinding(admission.permit, identity)).toEqual({
        kind: 'already-settled',
      });
      expect(statuses).toEqual(new Set());
      expect(coordinator.reservationFor(identity.jobId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports every binding retirement disposition and retains a refused successor', async () => {
    vi.useFakeTimers();
    try {
      let clearAllowed = false;
      const identity = { jobId: 'retirement-disposition-job', operationId: 'retirement-disposition-operation' };
      coordinator.connectProviderOperationBindingJournal(() => ({
        kind: 'unknown',
        reason: 'journal unavailable',
      }));
      coordinator.connectSettledUnboundStatus({
        rebind: () => null,
        record: (settled) => ({ kind: 'recorded', ownership: testSettledUnboundOwnership(settled) }),
        clear: () => clearAllowed,
        clearAbsent: () => clearAllowed,
        clearRefusal: () => {},
      });
      expect(coordinator.settleProviderOperationBinding(identity)).toEqual({ kind: 'settled-unbound' });
      await vi.advanceTimersByTimeAsync(SETTLED_UNBOUND_ABSENCE_CHECK_MS * SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT);

      expect(coordinator.retireProviderOperationBinding(identity)).toEqual({
        kind: 'refused',
        reason: 'The durable unsettled settlement status could not be cleared.',
      });
      clearAllowed = true;
      expect(coordinator.retireProviderOperationBinding(identity)).toEqual({ kind: 'retired' });
      expect(coordinator.retireProviderOperationBinding(identity)).toEqual({ kind: 'nothing-to-retire' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a recorded durable successor against the unresolved settlement budget', async () => {
    vi.useFakeTimers();
    try {
      coordinator.connectProviderOperationBindingJournal(() => ({
        kind: 'unknown',
        reason: 'journal unavailable',
      }));
      coordinator.connectSettledUnboundStatus({
        rebind: () => null,
        record: (identity) => ({ kind: 'recorded', ownership: testSettledUnboundOwnership(identity) }),
        clear: () => true,
        clearAbsent: () => true,
        clearRefusal: () => {},
      });
      expect(
        coordinator.settleProviderOperationBinding({
          jobId: 'durable-successor-job',
          operationId: 'durable-successor-operation',
        }),
      ).toEqual({ kind: 'settled-unbound' });
      await vi.advanceTimersByTimeAsync(SETTLED_UNBOUND_ABSENCE_CHECK_MS * SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT);

      for (let index = 0; index < MAX_SETTLED_UNBOUND_BINDINGS - 1; index += 1) {
        expect(
          coordinator.settleProviderOperationBinding({
            jobId: `successor-mailbox-job-${index}`,
            operationId: `successor-mailbox-operation-${index}`,
          }),
        ).toEqual({ kind: 'settled-unbound' });
      }
      expect(
        coordinator.settleProviderOperationBinding({
          jobId: 'successor-mailbox-overflow',
          operationId: 'successor-mailbox-overflow',
        }),
      ).toMatchObject({ kind: 'refused' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a status-recording refusal against the unresolved settlement budget', async () => {
    vi.useFakeTimers();
    try {
      coordinator.connectProviderOperationBindingJournal(() => ({
        kind: 'unknown',
        reason: 'journal unavailable',
      }));
      coordinator.connectSettledUnboundStatus({
        rebind: () => null,
        record: () => ({ kind: 'refused', reason: 'status store unavailable' }),
        clear: () => false,
        clearAbsent: () => false,
        clearRefusal: () => {},
      });
      expect(
        coordinator.settleProviderOperationBinding({
          jobId: 'refused-successor-job',
          operationId: 'refused-successor-operation',
        }),
      ).toEqual({ kind: 'settled-unbound' });
      await vi.advanceTimersByTimeAsync(SETTLED_UNBOUND_ABSENCE_CHECK_MS * SETTLED_UNBOUND_UNKNOWN_OBSERVATION_LIMIT);

      for (let index = 0; index < MAX_SETTLED_UNBOUND_BINDINGS - 1; index += 1) {
        expect(
          coordinator.settleProviderOperationBinding({
            jobId: `refused-successor-mailbox-job-${index}`,
            operationId: `refused-successor-mailbox-operation-${index}`,
          }),
        ).toEqual({ kind: 'settled-unbound' });
      }
      expect(
        coordinator.settleProviderOperationBinding({
          jobId: 'refused-successor-mailbox-overflow',
          operationId: 'refused-successor-mailbox-overflow',
        }),
      ).toMatchObject({ kind: 'refused' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds unsettled mailbox entries', () => {
    vi.useFakeTimers();
    try {
      for (let index = 0; index < MAX_SETTLED_UNBOUND_BINDINGS; index += 1) {
        expect(
          coordinator.settleProviderOperationBinding({
            jobId: `mailbox-job-${index}`,
            operationId: `operation-${index}`,
          }),
        ).toEqual({ kind: 'settled-unbound' });
      }
      expect(
        coordinator.settleProviderOperationBinding({ jobId: 'mailbox-overflow', operationId: 'operation-overflow' }),
      ).toMatchObject({ kind: 'refused' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a prepared source permit and makes repeated settlement idempotent', () => {
    const admission = coordinator.requestLaunch('job-prepared', 'codex', providerOwner('session-prepared'), 'default');
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected source permit');
    const identity = { jobId: 'job-prepared', operationId: 'operation-prepared' };

    expect(coordinator.prepareProviderOperationBinding(admission.permit, identity)).toEqual({ kind: 'prepared' });
    expect(coordinator.settleProviderOperationBinding(identity)).toEqual({
      kind: 'settled',
      reservationId: admission.permit.reservationId,
    });
    expect(coordinator.settleProviderOperationBinding(identity)).toEqual({ kind: 'already-settled' });
    expect(coordinator.commitProviderOperationBinding(identity)).toEqual({ kind: 'already-settled' });
    expect(coordinator.releaseLaunch(admission.permit)).toEqual({ kind: 'already-released', pool: 'default' });
  });

  it('does not let delayed settlement for an old operation release a newer job generation', () => {
    const first = coordinator.requestLaunch('job-reused-operation', 'codex', providerOwner('first'), 'default');
    if (first === 'queue_full' || first.type !== 'immediate') throw new Error('expected first permit');
    const oldOperation = { jobId: first.permit.jobId, operationId: 'old-operation' };
    expect(coordinator.prepareProviderOperationBinding(first.permit, oldOperation)).toEqual({ kind: 'prepared' });
    expect(coordinator.releaseLaunch(first.permit)).toMatchObject({ kind: 'released' });

    const second = coordinator.requestLaunch('job-reused-operation', 'codex', providerOwner('second'), 'default');
    if (second === 'queue_full' || second.type !== 'immediate') throw new Error('expected second permit');

    expect(coordinator.settleProviderOperationBinding(oldOperation)).toEqual({ kind: 'settled-unbound' });
    expect(coordinator.reservationFor(second.permit.jobId)).toMatchObject({
      kind: 'active',
      executionOwner: providerOwner('second'),
    });
    expect(coordinator.releaseLaunch(second.permit)).toMatchObject({ kind: 'released' });
  });

  it('retires the exact prepared binding when its source permit completes', () => {
    const old = coordinator.requestLaunch('job-refused-bind', 'codex', providerOwner('old'), 'default');
    if (old === 'queue_full' || old.type !== 'immediate') throw new Error('expected old permit');
    const identity = { jobId: old.permit.jobId, operationId: 'operation-refused-bind' };
    expect(coordinator.prepareProviderOperationBinding(old.permit, identity)).toEqual({ kind: 'prepared' });
    expect(coordinator.releaseLaunch(old.permit)).toMatchObject({ kind: 'released' });

    const current = coordinator.requestLaunch('job-refused-bind', 'codex', providerOwner('current'), 'default');
    if (current === 'queue_full' || current.type !== 'immediate') throw new Error('expected current permit');
    expect(coordinator.prepareProviderOperationBinding(current.permit, identity)).toEqual({ kind: 'prepared' });
    expect(coordinator.reservationFor(current.permit.jobId)).toMatchObject({ kind: 'active' });

    expect(coordinator.releaseLaunch(current.permit)).toMatchObject({ kind: 'released' });
    expect(coordinator.reservationFor(current.permit.jobId)).toBeNull();
  });

  it('keys operation bindings by both job and operation id', () => {
    const first = coordinator.requestLaunch('job-one', 'codex', providerOwner('session-one'), 'default');
    const second = coordinator.requestLaunch('job-two', 'codex', providerOwner('session-two'), 'discuss');
    if (first === 'queue_full' || first.type !== 'immediate') throw new Error('expected first source permit');
    if (second === 'queue_full' || second.type !== 'immediate') throw new Error('expected second source permit');

    const operationId = 'shared-operation-id';
    expect(coordinator.prepareProviderOperationBinding(first.permit, { jobId: 'job-one', operationId })).toEqual({
      kind: 'prepared',
    });
    expect(coordinator.prepareProviderOperationBinding(second.permit, { jobId: 'job-two', operationId })).toEqual({
      kind: 'prepared',
    });
    expect(coordinator.settleProviderOperationBinding({ jobId: 'job-one', operationId })).toMatchObject({
      kind: 'settled',
      reservationId: first.permit.reservationId,
    });
    expect(coordinator.reservationFor('job-two')).toMatchObject({ kind: 'active' });
  });

  it('cancels only the matching prepared operation binding', () => {
    const admission = coordinator.requestLaunch('job-cancel', 'codex', providerOwner('session-cancel'), 'default');
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected source permit');
    const identity = { jobId: 'job-cancel', operationId: 'operation-cancel' };
    expect(coordinator.prepareProviderOperationBinding(admission.permit, identity)).toEqual({ kind: 'prepared' });

    const wrongPermit = { ...admission.permit, reservationId: 'stale-reservation' };
    expect(coordinator.cancelProviderOperationBinding(wrongPermit, identity)).toMatchObject({ kind: 'refused' });
    expect(coordinator.cancelProviderOperationBinding(admission.permit, identity)).toEqual({ kind: 'cancelled' });
    expect(coordinator.reservationFor(identity.jobId)).toMatchObject({
      kind: 'active',
      holder: { kind: 'local-execution' },
    });
  });

  it('returns the exact admitted permit when cancellation loses the queue race', async () => {
    const blocker = coordinator.requestLaunch('blocker', 'codex', providerOwner('blocker-session'), 'default');
    if (blocker === 'queue_full' || blocker.type !== 'immediate') throw new Error('expected blocker permit');
    const queued = coordinator.requestLaunch('racing', 'codex', providerOwner('racing-session'), 'default');
    if (queued === 'queue_full' || queued.type !== 'queued') throw new Error('expected queued reservation');
    const waiting = queued.waitForPermit();

    coordinator.releaseLaunch(blocker.permit);
    const cancellation = queued.cancel();
    if (cancellation.kind !== 'admitted') throw new Error('expected admission to win');
    expect(cancellation.permit.holder).toEqual({ kind: 'queue-handoff' });
    expect(coordinator.releaseLaunch(cancellation.permit)).toMatchObject({ kind: 'released' });
    const waiterPermit = await waiting;
    expect(waiterPermit.reservationId).toBe(cancellation.permit.reservationId);
    expect(coordinator.releaseLaunch(waiterPermit)).toEqual({ kind: 'already-released', pool: 'default' });
  });

  it('confirms termination when a refused attempt is followed by observed absence', async () => {
    const cleanupHandles = (coordinator as unknown as { readonly cleanupHandles: Map<symbol, DurableProcessCleanup> })
      .cleanupHandles;
    const cleanupKey = Symbol('refused-child');
    let attempts = 0;
    cleanupHandles.set(cleanupKey, async () => {
      attempts += 1;
      return attempts === 1
        ? {
            kind: 'signal-refused' as const,
            pid: TEST_PROVIDER_PID,
            reason: 'recorded-incarnation-unavailable' as const,
          }
        : { kind: 'observed-absent' as const, pid: TEST_PROVIDER_PID };
    });

    const termination = coordinator.terminateAll();
    await new Promise((resolve) => setTimeout(resolve, 75));

    await expect(termination).resolves.toEqual({ kind: 'all-observed-absent' });
    expect(cleanupHandles.has(cleanupKey)).toBe(false);
  });

  it('retains and identifies a child that is still alive at the deadline', async () => {
    const cleanupHandles = (coordinator as unknown as { readonly cleanupHandles: Map<symbol, DurableProcessCleanup> })
      .cleanupHandles;
    const cleanupKey = Symbol('alive-child');
    cleanupHandles.set(cleanupKey, async () => ({
      kind: 'target-alive',
      pid: TEST_PROVIDER_PID,
      stage: 'after-sigkill',
    }));
    const controller = new AbortController();
    const termination = coordinator.terminateAll(controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(termination).resolves.toEqual({
      kind: 'unresolved-at-deadline',
      processes: [{ kind: 'target-alive', pid: TEST_PROVIDER_PID, stage: 'after-sigkill' }],
      pendingLaunches: 0,
      retainedLaunches: [],
      cleanupHandles: 1,
      retainedProcesses: [],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });
    expect(cleanupHandles.has(cleanupKey)).toBe(true);
  });

  it('joins a cleanup attempt that outlives the caller deadline', async () => {
    const cleanupHandles = (coordinator as unknown as { readonly cleanupHandles: Map<symbol, DurableProcessCleanup> })
      .cleanupHandles;
    let settleCleanup!: (outcome: { kind: 'observed-absent'; pid: number }) => void;
    const cleanupSettlement = new Promise<{ kind: 'observed-absent'; pid: number }>((resolve) => {
      settleCleanup = resolve;
    });
    const cleanup = vi.fn(() => cleanupSettlement);
    cleanupHandles.set(Symbol('deferred-child'), cleanup);
    const controller = new AbortController();

    const initial = coordinator.terminateAll(controller.signal);
    controller.abort();
    await expect(initial).resolves.toMatchObject({ kind: 'unresolved-at-deadline' });

    const retry = coordinator.terminateAll();
    expect(cleanup).toHaveBeenCalledOnce();
    settleCleanup({ kind: 'observed-absent', pid: TEST_PROVIDER_PID });
    await expect(retry).resolves.toEqual({ kind: 'all-observed-absent' });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('starts a fresh cleanup immediately when a timed-out attempt later settles without absence', async () => {
    const cleanupHandles = (coordinator as unknown as { readonly cleanupHandles: Map<symbol, DurableProcessCleanup> })
      .cleanupHandles;
    let settleCleanup!: (outcome: { kind: 'target-unobservable'; pid: number; stage: 'after-sigkill' }) => void;
    const firstSettlement = new Promise<{ kind: 'target-unobservable'; pid: number; stage: 'after-sigkill' }>(
      (resolve) => {
        settleCleanup = resolve;
      },
    );
    const cleanup = vi
      .fn<DurableProcessCleanup>()
      .mockImplementationOnce(() => firstSettlement)
      .mockResolvedValueOnce({ kind: 'observed-absent', pid: TEST_PROVIDER_PID });
    cleanupHandles.set(Symbol('deferred-child'), cleanup);
    const controller = new AbortController();

    const initial = coordinator.terminateAll(controller.signal);
    controller.abort();
    await expect(initial).resolves.toMatchObject({ kind: 'unresolved-at-deadline' });
    expect(cleanup).toHaveBeenCalledOnce();

    settleCleanup({ kind: 'target-unobservable', pid: TEST_PROVIDER_PID, stage: 'after-sigkill' });
    await firstSettlement;
    const retry = coordinator.terminateAll();

    expect(cleanup).toHaveBeenCalledTimes(2);
    await expect(retry).resolves.toEqual({ kind: 'all-observed-absent' });
  });

  it('returns unresolved ownership when its abort signal bounds an unobservable child', async () => {
    const cleanupHandles = (coordinator as unknown as { readonly cleanupHandles: Map<symbol, DurableProcessCleanup> })
      .cleanupHandles;
    const cleanupKey = Symbol('unobservable-child');
    cleanupHandles.set(cleanupKey, async () => ({
      kind: 'target-unobservable',
      pid: TEST_PROVIDER_PID,
      stage: 'after-sigkill',
    }));
    const controller = new AbortController();
    const termination = coordinator.terminateAll(controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(termination).resolves.toEqual({
      kind: 'unresolved-at-deadline',
      processes: [
        {
          kind: 'target-unobservable',
          pid: TEST_PROVIDER_PID,
          stage: 'after-sigkill',
        },
      ],
      pendingLaunches: 0,
      retainedLaunches: [],
      cleanupHandles: 1,
      retainedProcesses: [],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });
    expect(cleanupHandles.has(cleanupKey)).toBe(true);
  });

  it('bounds a pending wrapper join and reports the retained launch identity', async () => {
    const base = createRealRuntime('prod');
    const runtime: Runtime = {
      ...base,
      process: {
        ...base.process,
        durable: {
          ...base.process.durable,
          launch: () => new Promise<never>(() => undefined),
        },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    void localCoordinator.spawnDurableJob({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: '/tmp/pending-wrapper',
    });
    const controller = new AbortController();
    const termination = localCoordinator.terminateAll(controller.signal);

    controller.abort();

    await expect(termination).resolves.toEqual({
      kind: 'unresolved-at-deadline',
      processes: [],
      pendingLaunches: 1,
      retainedLaunches: [{ kind: 'awaiting-wrapper-identity', provider: 'codex', jobDir: '/tmp/pending-wrapper' }],
      cleanupHandles: 0,
      retainedProcesses: [],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });
  });

  it('retains a held durable launch until its join settles before propagating failure', async () => {
    const base = createRealRuntime('prod');
    let observeLaunch!: () => void;
    const launchObserved = new Promise<void>((resolve) => {
      observeLaunch = resolve;
    });
    let settleRetry!: () => void;
    const retryAfter = new Promise<void>((resolve) => {
      settleRetry = resolve;
    });
    const retry = vi.fn(async () => ({ disposition: 'settled' as const }));
    const launch = vi.fn(async () => {
      observeLaunch();
      return {
        disposition: 'held' as const,
        owner: 'launch-caller' as const,
        pid: TEST_PROVIDER_PID,
        reason: 'synthetic held launch',
        retryAfter,
        retry,
      };
    });
    const runtime: Runtime = {
      ...base,
      process: {
        ...base.process,
        durable: { ...base.process.durable, launch },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const spawn = localCoordinator.spawnDurableJob({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: '/tmp/held-durable-launch',
    });
    await launchObserved;

    let terminationSettled = false;
    const termination = localCoordinator.terminateAll().then((result) => {
      terminationSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(terminationSettled).toBe(false);
    expect(retry).not.toHaveBeenCalled();

    settleRetry();

    await expect(spawn).rejects.toThrow('synthetic held launch');
    expect(retry).toHaveBeenCalledOnce();
    await expect(termination).resolves.toEqual({ kind: 'all-observed-absent' });
  });

  it('keeps a caller-owned launch slot while an aborted wrapper remains unsettled', async () => {
    process.env.CORAL_MAX_WORKERS = '1';
    const base = createRealRuntime('prod');
    const requestTermination = vi.fn(() => ({
      kind: 'signal-failed' as const,
      pid: TEST_PROVIDER_PID,
      signal: 'SIGTERM' as const,
      reason: 'kill-port-returned-false' as const,
    }));
    let acceptWrapper!: () => void;
    const wrapperAccepted = new Promise<void>((resolve) => {
      acceptWrapper = resolve;
    });
    let settleWrapper!: () => void;
    const wrapperSettlement = new Promise<void>((resolve) => {
      settleWrapper = resolve;
    });
    let identifyWrapper!: () => void;
    let observeContainmentHold!: () => void;
    const containmentHeld = new Promise<void>((resolve) => {
      observeContainmentHold = resolve;
    });
    const launch = vi.fn((options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
      options.onWrapperSpawned?.({
        pid: TEST_PROVIDER_PID,
        settled: wrapperSettlement,
        requestTermination,
      });
      identifyWrapper = () =>
        options.onWrapperIdentified?.({
          runtimeRecord: {
            transport: 'durable-cli',
            pid: TEST_PROVIDER_PID,
            stdoutPath: '/tmp/accepted-pending-wrapper/stdout',
            stderrPath: '/tmp/accepted-pending-wrapper/stderr',
            startTime: new Date(0).toISOString(),
          },
          pid: TEST_PROVIDER_PID,
          leaderIncarnation: TEST_PROVIDER_INCARNATION,
          signalAuthority: testSignalAuthority(TEST_PROVIDER_PID, () => false),
        });
      acceptWrapper();
      return new Promise<never>(() => undefined);
    });
    let elapsedMs = 0n;
    const runtime: Runtime = {
      ...base,
      time: {
        ...base.time,
        monotonicNow: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += BigInt(milliseconds);
        },
      },
      process: {
        ...base.process,
        kill: (_pid, signal) => signal === 0,
        observeLiveness: () => 'alive',
        readProcessIncarnation: () => TEST_PROVIDER_INCARNATION,
        observeRecordedProcessAsync: async () => 'alive',
        durable: { ...base.process.durable, launch },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const abortRegistry = new AbortRegistry(runtime.ids);
    const admission = localCoordinator.requestLaunch(
      'caller-owned-pending-wrapper',
      'codex',
      providerOwner('caller-owned-pending-wrapper'),
      'default',
    );
    if (admission === 'queue_full' || admission.type !== 'immediate') throw new Error('expected caller permit');
    const callerPermit = admission.permit;
    abortRegistry.register(callerPermit.jobId, undefined, () => localCoordinator.releaseLaunch(callerPermit));
    void localCoordinator.spawnDurableJob({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: '/tmp/accepted-pending-wrapper',
      jobId: callerPermit.jobId,
      callerOwnership: { permit: callerPermit, abortHoldOwner: abortRegistry },
      signal: abortRegistry.getSignal(callerPermit.jobId) ?? undefined,
      onDurableProcessIdentity: (_identity, status) => {
        if (status?.kind === 'held') observeContainmentHold();
        return { kind: 'published' };
      },
    });
    await wrapperAccepted;
    const queued = localCoordinator.requestLaunch(
      'queued-after-caller-wrapper',
      'codex',
      providerOwner('queued-after-caller-wrapper'),
      'default',
    );
    if (queued === 'queue_full' || queued.type !== 'queued') throw new Error('expected queued launch');

    const abort = abortRegistry.abort([callerPermit.jobId]);

    expect(requestTermination).toHaveBeenCalledOnce();
    expect(abort.refused).toEqual([
      expect.objectContaining({
        jobId: callerPermit.jobId,
        reason: 'pending wrapper termination failed: SIGTERM:kill-port-returned-false',
      }),
    ]);
    expect(localCoordinator.reservationFor(callerPermit.jobId)).toMatchObject({ kind: 'active' });
    expect(localCoordinator.queuePosition('queued-after-caller-wrapper', 'default')).toBe(1);

    identifyWrapper();
    await containmentHeld;
    settleWrapper();
    await Promise.resolve();
    expect(localCoordinator.reservationFor(callerPermit.jobId)).toMatchObject({ kind: 'active' });
    expect(localCoordinator.queuePosition('queued-after-caller-wrapper', 'default')).toBe(1);

    await vi.waitFor(() => {
      expect(abortRegistry.abort([callerPermit.jobId]).abandoned).toEqual([
        expect.objectContaining({ jobId: callerPermit.jobId }),
      ]);
    });
    const admitted = await queued.waitForPermit();
    expect(localCoordinator.reservationFor(callerPermit.jobId)).toBeNull();
    expect(localCoordinator.reservationFor(admitted.jobId)).toMatchObject({ kind: 'active' });
    expect(localCoordinator.releaseLaunch(admitted)).toMatchObject({ kind: 'released' });
  });

  it('keeps the launch slot while an aborted pending wrapper termination has not settled', async () => {
    const base = createRealRuntime('prod');
    let acceptWrapper!: () => void;
    const wrapperAccepted = new Promise<void>((resolve) => {
      acceptWrapper = resolve;
    });
    let settleWrapper!: () => void;
    const wrapperSettlement = new Promise<void>((resolve) => {
      settleWrapper = resolve;
    });
    const requestTermination = vi.fn(() => ({
      kind: 'signal-failed' as const,
      pid: TEST_PROVIDER_PID,
      signal: 'SIGTERM' as const,
      reason: 'kill-port-returned-false' as const,
    }));
    const launch = vi.fn((options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
      options.onWrapperSpawned?.({
        pid: TEST_PROVIDER_PID,
        settled: wrapperSettlement,
        requestTermination,
      });
      acceptWrapper();
      return new Promise<never>(() => undefined);
    });
    const runtime: Runtime = {
      ...base,
      process: {
        ...base.process,
        durable: { ...base.process.durable, launch },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    void localCoordinator.spawnDurableJob({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: '/tmp/pending-wrapper-slot',
    });
    await wrapperAccepted;
    const [pendingPermit] = localCoordinator.activeLaunchPermits();
    if (pendingPermit === undefined || pendingPermit.holder.kind !== 'system-task') {
      throw new Error('expected pending durable launch permit');
    }
    const queued = localCoordinator.requestLaunch(
      'queued-after-pending-wrapper',
      'codex',
      providerOwner('queued-after-pending-wrapper'),
      'default',
    );
    if (queued === 'queue_full' || queued.type !== 'queued') throw new Error('expected queued launch');

    const abort = localCoordinator.getInternalAbortRegistry().abort([pendingPermit.jobId]);
    expect(abort.refused).toEqual([
      expect.objectContaining({
        jobId: pendingPermit.jobId,
        reason: 'pending wrapper termination failed: SIGTERM:kill-port-returned-false',
      }),
    ]);
    expect(localCoordinator.reservationFor(pendingPermit.jobId)).toMatchObject({ kind: 'active' });
    expect(localCoordinator.queuePosition('queued-after-pending-wrapper', 'default')).toBe(1);

    settleWrapper();
    const admitted = await queued.waitForPermit();
    expect(localCoordinator.reservationFor(pendingPermit.jobId)).toBeNull();
    expect(localCoordinator.reservationFor(admitted.jobId)).toMatchObject({ kind: 'active' });
    expect(localCoordinator.releaseLaunch(admitted)).toMatchObject({ kind: 'released' });
  });

  it('reaps a live Darwin wrapper before propagating a readiness rejection', async () => {
    const base = createRealRuntime('prod');
    const incarnation = testIncarnation(7_001);
    let elapsedMs = 0n;
    let exited = false;
    let settleWrapper!: () => void;
    const wrapperSettlement = new Promise<void>((resolve) => {
      settleWrapper = resolve;
    });
    const launch = vi.fn(async (options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
      options.onWrapperSpawned?.({
        pid: TEST_PROVIDER_PID,
        settled: wrapperSettlement,
        requestTermination: () => ({
          kind: 'signal-failed',
          pid: null,
          signal: 'SIGTERM',
          reason: 'kill-port-returned-false',
        }),
      });
      options.onWrapperIdentified?.({
        runtimeRecord: {
          transport: 'durable-cli',
          pid: TEST_PROVIDER_PID,
          stdoutPath: '/tmp/readiness-rejection/stdout',
          stderrPath: '/tmp/readiness-rejection/stderr',
          startTime: new Date(0).toISOString(),
        },
        pid: TEST_PROVIDER_PID,
        leaderIncarnation: incarnation,
        signalAuthority: testSignalAuthority(TEST_PROVIDER_PID, () => exited),
      });
      throw new Error('synthetic readiness rejection');
    });
    const kill = vi.fn<ProcessPort['kill']>((pid, signal) => {
      if (signal === 0) return !exited;
      expect(pid).toBe(-TEST_PROVIDER_PID);
      exited = true;
      settleWrapper();
      return true;
    });
    const runtime: Runtime = {
      ...base,
      env: { ...base.env, platform: () => 'darwin' },
      time: {
        ...base.time,
        monotonicNow: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += BigInt(milliseconds);
        },
      },
      process: {
        ...base.process,
        kill,
        observeLiveness: () => (exited ? 'absent' : 'alive'),
        readProcessIncarnation: () => (exited ? null : incarnation),
        observeRecordedProcessAsync: async () => (exited ? 'absent' : 'alive'),
        durable: { ...base.process.durable, launch },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });

    await expect(
      localCoordinator.spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/readiness-rejection',
      }),
    ).rejects.toThrow('synthetic readiness rejection');

    await expect(localCoordinator.terminateAll()).resolves.toEqual({ kind: 'all-observed-absent' });
    expect(kill).toHaveBeenCalledWith(-TEST_PROVIDER_PID, 'SIGTERM');
  });

  it('publishes and abandons an incarnation-bound wrapper hold after readiness rejects', async () => {
    const base = createRealRuntime('prod');
    const incarnation = testIncarnation(7_002);
    let elapsedMs = 0n;
    const requestTermination = vi.fn();
    let settleWrapper!: () => void;
    const wrapperSettlement = new Promise<void>((resolve) => {
      settleWrapper = resolve;
    });
    const launch = vi.fn(async (options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
      options.onWrapperSpawned?.({
        pid: TEST_PROVIDER_PID,
        settled: wrapperSettlement,
        requestTermination,
      });
      options.onWrapperIdentified?.({
        runtimeRecord: {
          transport: 'durable-cli',
          pid: TEST_PROVIDER_PID,
          stdoutPath: '/tmp/provisional-readiness-rejection/stdout',
          stderrPath: '/tmp/provisional-readiness-rejection/stderr',
          startTime: new Date(0).toISOString(),
        },
        pid: TEST_PROVIDER_PID,
        leaderIncarnation: incarnation,
        signalAuthority: testSignalAuthority(TEST_PROVIDER_PID, () => false, requestTermination),
      });
      throw new Error('synthetic provisional readiness rejection');
    });
    const runtime: Runtime = {
      ...base,
      env: { ...base.env, platform: () => 'darwin' },
      time: {
        ...base.time,
        monotonicNow: () => elapsedMs,
        sleep: async (milliseconds) => {
          elapsedMs += BigInt(milliseconds);
        },
      },
      process: {
        ...base.process,
        observeLiveness: () => 'alive',
        readProcessIncarnation: () => null,
        durable: { ...base.process.durable, launch },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const observations = vi.fn(
      (
        identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
        status?: DurableContainmentStatus,
        control?: DurableContainmentOperatorControl,
      ) => {
        if (status?.kind === 'held') {
          expect(identity).toEqual({
            kind: 'provisional-wrapper',
            pid: TEST_PROVIDER_PID,
            incarnation,
            processGroupId: TEST_PROVIDER_PID,
            provider: 'codex',
            jobDir: '/tmp/provisional-readiness-rejection',
          });
          const abandonment = control?.abandon();
          expect(abandonment).toEqual({
            kind: 'abandoned',
            reason: 'job ownership was released without proof of process absence',
            nextStep: 'Inspect the recorded process because it may still be live.',
          });
          if (abandonment?.kind === 'abandoned') settleWrapper();
        }
        return { kind: 'published' as const };
      },
    );

    await expect(
      localCoordinator.spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/provisional-readiness-rejection',
        onDurableProcessIdentity: observations,
      }),
    ).rejects.toThrow('synthetic provisional readiness rejection');

    expect(requestTermination).not.toHaveBeenCalled();
    expect(
      observations.mock.calls.some(([identity, status]) => 'kind' in identity && status?.kind === 'operator-abandoned'),
    ).toBe(true);
    await expect(localCoordinator.terminateAll()).resolves.toEqual({ kind: 'all-observed-absent' });
  });

  it('does not mint absence from an abruptly dead wrapper while its recorded child remains alive', async () => {
    const base = createRealRuntime('prod');
    let rejectLaunch!: (error: Error) => void;
    const incarnation = testIncarnation(7_001);
    const childPid = TEST_PROVIDER_PID + 1;
    const launch = vi.fn((options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
      options.onSpawned?.({
        runtimeRecord: {
          transport: 'durable-cli',
          pid: TEST_PROVIDER_PID,
          stdoutPath: '/tmp/unpublished-launch/stdout',
          stderrPath: '/tmp/unpublished-launch/stderr',
          startTime: new Date(0).toISOString(),
        },
        leaderIncarnation: incarnation,
        childRoot: { pid: childPid, incarnation },
      });
      return new Promise<never>((_resolve, reject) => {
        rejectLaunch = reject;
      });
    });
    const runtime: Runtime = {
      ...base,
      time: {
        ...base.time,
        sleep: () => new Promise<never>(() => undefined),
      },
      process: {
        ...base.process,
        kill: vi.fn(() => true),
        observeLiveness: (pid) => (pid === TEST_PROVIDER_PID ? 'absent' : 'alive'),
        readProcessIncarnation: (pid) => (pid === TEST_PROVIDER_PID ? null : incarnation),
        durable: { ...base.process.durable, launch },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const onRuntimeRecord = vi.fn();
    const onDurableProcessIdentity = vi.fn();
    const spawn = localCoordinator.spawnDurableJob({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: '/tmp/unpublished-launch',
      onRuntimeRecord,
      onDurableProcessIdentity,
    });
    const controller = new AbortController();
    const termination = localCoordinator.terminateAll(controller.signal);

    controller.abort();

    await expect(termination).resolves.toEqual({
      kind: 'unresolved-at-deadline',
      processes: [],
      pendingLaunches: 0,
      retainedLaunches: [],
      cleanupHandles: 1,
      retainedProcesses: [
        {
          kind: 'recorded-wrapper-group',
          provider: 'codex',
          jobDir: '/tmp/unpublished-launch',
          containment: {
            pid: TEST_PROVIDER_PID,
            incarnation,
            processGroupId: TEST_PROVIDER_PID,
            childRoot: { pid: childPid, incarnation },
          },
        },
      ],
      cleanupFailures: 0,
      owner: 'launch-coordinator',
    });
    expect(onRuntimeRecord).toHaveBeenCalledOnce();
    expect(onDurableProcessIdentity).toHaveBeenCalledWith({
      pid: TEST_PROVIDER_PID,
      incarnation,
      processGroupId: TEST_PROVIDER_PID,
      childRoot: { pid: childPid, incarnation },
    });
    expect(runtime.process.kill).not.toHaveBeenCalled();
    rejectLaunch(new Error('synthetic launch settlement'));
    void spawn.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(onDurableProcessIdentity.mock.calls.some(([, status]) => status?.kind === 'held')).toBe(true);
    expect(
      (localCoordinator as unknown as { readonly cleanupHandles: Map<symbol, DurableProcessCleanup> }).cleanupHandles
        .size,
    ).toBe(1);
  });

  it('releases cleanup ownership before propagating a wrapper crash', async () => {
    const base = createRealRuntime('prod');
    const incarnation = testIncarnation(7_002);
    const childRoot = { pid: TEST_PROVIDER_PID + 1, incarnation };
    const runtimeRecord = {
      transport: 'durable-cli' as const,
      pid: TEST_PROVIDER_PID,
      stdoutPath: '/tmp/wrapper-crash/stdout',
      stderrPath: '/tmp/wrapper-crash/stderr',
      startTime: new Date(0).toISOString(),
    };
    const wrapperError = new Error('synthetic wrapper crash');
    const runtime: Runtime = {
      ...base,
      time: {
        ...base.time,
        sleep: async () => undefined,
      },
      process: {
        ...base.process,
        observeLiveness: () => 'absent',
        readProcessIncarnation: () => null,
        durable: {
          launch: async (options) => {
            options.onSpawned?.({ runtimeRecord, leaderIncarnation: incarnation, childRoot });
            return {
              disposition: 'launched',
              launchHandle: 'wrapper-crash' as never,
              pid: TEST_PROVIDER_PID,
              stdoutPath: runtimeRecord.stdoutPath,
              stderrPath: runtimeRecord.stderrPath,
              runtimeRecord,
              processSubject: {
                pid: TEST_PROVIDER_PID,
                incarnation,
                processGroupId: TEST_PROVIDER_PID,
                childRoot,
              },
            };
          },
          waitForExit: async () => {
            throw wrapperError;
          },
        },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const cleanupOwnership = localCoordinator as unknown as {
      readonly cleanupHandles: Map<symbol, DurableProcessCleanup>;
      readonly cleanupRetentions: Map<DurableProcessCleanup, unknown>;
    };

    await expect(
      localCoordinator.spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/wrapper-crash',
      }),
    ).rejects.toBe(wrapperError);

    expect(cleanupOwnership.cleanupHandles.size).toBe(0);
    expect(cleanupOwnership.cleanupRetentions.size).toBe(0);
  });

  it('lets the reported synthetic holder abort a stuck containment and release its exact permit', async () => {
    const base = createRealRuntime('prod');
    const incarnation = testIncarnation(7_002);
    const childRoot = { pid: TEST_PROVIDER_PID + 1, incarnation };
    const runtimeRecord = {
      transport: 'durable-cli' as const,
      pid: TEST_PROVIDER_PID,
      stdoutPath: '/tmp/held-result/stdout',
      stderrPath: '/tmp/held-result/stderr',
      startTime: new Date(0).toISOString(),
    };
    const runtime: Runtime = {
      ...base,
      env: { ...base.env, platform: () => 'darwin' },
      process: {
        ...base.process,
        kill: vi.fn(() => true),
        observeLiveness: () => 'alive',
        readProcessIncarnation: () => null,
        observeRecordedProcessAsync: async () => 'unknown',
        durable: {
          launch: async (options) => {
            options.onSpawned?.({ runtimeRecord, leaderIncarnation: incarnation, childRoot });
            return {
              disposition: 'launched',
              launchHandle: 'held-result' as never,
              pid: TEST_PROVIDER_PID,
              stdoutPath: runtimeRecord.stdoutPath,
              stderrPath: runtimeRecord.stderrPath,
              runtimeRecord,
              processSubject: {
                pid: TEST_PROVIDER_PID,
                incarnation,
                processGroupId: TEST_PROVIDER_PID,
                childRoot,
              },
              signalAuthority: testSignalAuthority(TEST_PROVIDER_PID, () => true),
            };
          },
          waitForExit: async () => ({ exitCode: 0, signal: null, endTime: new Date(1).toISOString() }),
        },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const holdControls: DurableContainmentOperatorControl[] = [];
    const observations = vi.fn(
      (
        _identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
        _status?: DurableContainmentStatus,
        control?: DurableContainmentOperatorControl,
      ) => {
        if (control !== undefined) holdControls.push(control);
        return { kind: 'published' as const };
      },
    );
    const spawn = localCoordinator.spawnDurableJob({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: '/tmp/held-result',
      onDurableProcessIdentity: observations,
    });

    await vi.waitFor(() => {
      expect(
        observations.mock.calls.some(
          ([identity, status]) =>
            identity.pid === TEST_PROVIDER_PID && status?.kind === 'held' && status.abandonment === 'abort-job',
        ),
      ).toBe(true);
    });
    const [holder] = localCoordinator.activeLaunchPermits();
    if (holder === undefined || holder.holder.kind !== 'system-task') {
      throw new Error('Expected the durable transport to report its synthetic holder.');
    }
    expect(localCoordinator.reservationFor(holder.jobId)).toMatchObject({ kind: 'active' });

    const firstAbort = localCoordinator.getInternalAbortRegistry().abort([holder.jobId]);
    expect(firstAbort.refused).toEqual([expect.objectContaining({ jobId: holder.jobId })]);
    const holdControl = holdControls.at(-1);
    if (holdControl === undefined) throw new Error('Expected durable containment abandonment control');
    let secondAbort: ReturnType<ReturnType<LaunchCoordinator['getInternalAbortRegistry']>['abort']> | undefined;
    await vi.waitFor(() => {
      secondAbort = localCoordinator.getInternalAbortRegistry().abort([holder.jobId]);
      expect(secondAbort.abandoned).toEqual([expect.objectContaining({ jobId: holder.jobId })]);
    });
    expect(localCoordinator.reservationFor(holder.jobId)).toBeNull();
    expect(localCoordinator.active).toBe(0);

    await expect(spawn).resolves.toMatchObject({ code: 0, aborted: true });
    expect(
      observations.mock.calls.some(
        ([identity, status]) =>
          identity.pid === TEST_PROVIDER_PID &&
          status?.kind === 'operator-abandoned' &&
          status.processAbsenceProven === false,
      ),
    ).toBe(true);
    expect(runtime.process.kill).not.toHaveBeenCalled();
    await expect(localCoordinator.terminateAll()).resolves.toEqual({ kind: 'all-observed-absent' });
  });

  it('retains cleanup ownership and settlement when absence publication fails', async () => {
    const base = createRealRuntime('prod');
    const incarnation = testIncarnation(7_003);
    const childRoot = { pid: TEST_PROVIDER_PID + 1, incarnation };
    const runtimeRecord = {
      transport: 'durable-cli' as const,
      pid: TEST_PROVIDER_PID,
      stdoutPath: '/tmp/failed-absence-publication/stdout',
      stderrPath: '/tmp/failed-absence-publication/stderr',
      startTime: new Date(0).toISOString(),
    };
    let processAbsent = false;
    let retryCleanup!: () => void;
    const retryHandle = {};
    const clearInterval = vi.fn();
    const exitRecord = { exitCode: 0, signal: null, endTime: new Date(1).toISOString() } as const;
    let resolveExit!: (record: typeof exitRecord) => void;
    const exit = new Promise<typeof exitRecord>((resolve) => {
      resolveExit = resolve;
    });
    const runtime: Runtime = {
      ...base,
      env: { ...base.env, platform: () => 'darwin' },
      time: {
        ...base.time,
        setInterval: (callback) => {
          retryCleanup = callback;
          return retryHandle;
        },
        clearInterval,
      },
      process: {
        ...base.process,
        kill: vi.fn(() => true),
        observeLiveness: () => (processAbsent ? 'absent' : 'unknown'),
        readProcessIncarnation: () => null,
        durable: {
          launch: async (options) => {
            options.onSpawned?.({ runtimeRecord, leaderIncarnation: incarnation, childRoot });
            return {
              disposition: 'launched',
              launchHandle: 'failed-absence-publication' as never,
              pid: TEST_PROVIDER_PID,
              stdoutPath: runtimeRecord.stdoutPath,
              stderrPath: runtimeRecord.stderrPath,
              runtimeRecord,
              processSubject: {
                pid: TEST_PROVIDER_PID,
                incarnation,
                processGroupId: TEST_PROVIDER_PID,
                childRoot,
              },
            };
          },
          waitForExit: () => exit,
        },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const abort = new AbortController();
    let identityPublished = false;
    let absencePublicationAttempts = 0;
    let holdControl: DurableContainmentOperatorControl | undefined;
    const observations = vi.fn(
      (
        _identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
        status?: DurableContainmentStatus,
        control?: DurableContainmentOperatorControl,
      ) => {
        if (status === undefined) identityPublished = true;
        if (status?.kind === 'held') holdControl = control;
        if (status?.kind === 'absence-confirmed') {
          absencePublicationAttempts += 1;
          return { kind: 'retained' as const, reason: 'synthetic absence publication failure' };
        }
        return { kind: 'published' as const };
      },
    );
    let settled = false;
    const spawn = localCoordinator
      .spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/failed-absence-publication',
        signal: abort.signal,
        onDurableProcessIdentity: observations,
      })
      .finally(() => {
        settled = true;
      });

    await vi.waitFor(() => expect(identityPublished).toBe(true));
    abort.abort();
    await vi.waitFor(() => expect(holdControl).toBeDefined());
    const cleanupOwnership = localCoordinator as unknown as {
      readonly cleanupHandles: Map<symbol, DurableProcessCleanup>;
      readonly cleanupRetentions: Map<DurableProcessCleanup, unknown>;
    };
    const retainedCleanup = [...cleanupOwnership.cleanupHandles.values()][0];
    if (retainedCleanup === undefined) throw new Error('Expected retained durable cleanup ownership');
    await retainedCleanup();
    processAbsent = true;
    retryCleanup();
    expect(holdControl?.abandon()).toEqual({
      kind: 'retained',
      reason: 'the active durable containment cleanup attempt is still settling',
      nextStep: 'Retry the abort after the active cleanup attempt settles.',
    });
    expect(cleanupOwnership.cleanupHandles.size).toBe(1);
    await retainedCleanup();

    expect(absencePublicationAttempts).toBe(1);
    expect(cleanupOwnership.cleanupHandles.size).toBe(1);
    expect(cleanupOwnership.cleanupRetentions.size).toBe(1);
    expect(clearInterval).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    expect(holdControl?.abandon()).toEqual({
      kind: 'abandoned',
      reason: 'job ownership was released without proof of process absence',
      nextStep: 'Inspect the recorded process because it may still be live.',
    });
    resolveExit(exitRecord);
    await expect(spawn).resolves.toMatchObject({ code: 0, aborted: true });
    expect(clearInterval).toHaveBeenCalledWith(retryHandle);
  });

  it('refuses new admission after shutdown begins', async () => {
    await expect(coordinator.terminateAll()).resolves.toEqual({ kind: 'all-observed-absent' });

    expect(() => coordinator.requestLaunch('late-job', 'codex', providerOwner('late-session'), 'default')).toThrow(
      'Launch rejected because shutdown has begun',
    );
    await expect(
      coordinator.spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/sim/jobs/late-job',
      }),
    ).rejects.toThrow('Launch rejected because shutdown has begun');
  });

  it('releases cleanup ownership only after observed absence', async () => {
    const cleanupHandles = (coordinator as unknown as { readonly cleanupHandles: Map<symbol, DurableProcessCleanup> })
      .cleanupHandles;
    const cleanupKey = Symbol('absent-child');
    cleanupHandles.set(cleanupKey, async () => ({ kind: 'observed-absent', pid: TEST_PROVIDER_PID }));

    await expect(coordinator.terminateAll()).resolves.toEqual({ kind: 'all-observed-absent' });
    expect(cleanupHandles.has(cleanupKey)).toBe(false);
  });
});
