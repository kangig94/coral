import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import type { DurableProcessCleanup } from '#src/coordinator/live/durable-transport.js';
import type { DurableContainmentOperatorControl } from '#src/providers/cli-runner.js';
import { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import type { LaunchPool } from '#src/jobs/contracts/admission.js';
import { canProbeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
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
  platform: ReturnType<typeof vi.fn<() => string>>;
} {
  const events = new EventEmitter();
  let processAlive = true;
  let groupAlive = groupProbeResult;
  const childKill = vi.fn<(signal?: NodeJS.Signals) => boolean>((signal) => {
    processAlive = false;
    groupAlive = false;
    queueMicrotask(() => events.emit('close', 0, signal ?? null));
    return true;
  });
  const child = {
    pid,
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
    queueMicrotask(() => events.emit('close', 0, signal));
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
    platform: readPlatform,
  };
}

function providerOwner(id: string) {
  return { kind: 'provider-session' as const, id };
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

    const handle = await localCoordinator.spawnProviderServer({
      provider: 'codex',
      command: 'fake-codex',
      args: ['app-server'],
    });

    expect(fake.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'fake-codex', args: ['app-server'], detached: true }),
    );
    expect(handle.containmentIdentity).toEqual({
      pid: TEST_PROVIDER_PID,
      incarnation: TEST_PROVIDER_INCARNATION,
      processGroupId: TEST_PROVIDER_PID,
    });
    expect(fake.processKill).toHaveBeenCalledWith(-TEST_PROVIDER_PID, 0);
    expect(fake.platform).toHaveBeenCalled();
    expect(handle.containmentIdentity.processGroupId).toBe(handle.containmentIdentity.pid);

    await handle.close();
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

  it('kills a coordinator-local provider spawn whose incarnation cannot be read', async () => {
    const fake = createProviderProcessRuntime(TEST_PROVIDER_PID, true, 'linux', null);
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
      context: { provider: 'codex', pid: TEST_PROVIDER_PID },
    });
    expect(fake.processKill).not.toHaveBeenCalled();
    expect(fake.childKill).toHaveBeenCalledWith('SIGTERM');
    expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
    expect([...manager.admissionSnapshot().state.values()].some((entry) => entry.phase === 'live')).toBe(false);
    expect(manager.listProviderHosts().some((entry) => entry.status === 'live')).toBe(false);
    await manager.shutdown();
  });

  it('kills a coordinator-local provider spawn when reading its incarnation throws', async () => {
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

    await expect(
      manager.openSession(createExclusiveSpec({ command: 'fake-codex', args: ['app-server'] }), { jobId: 'job-a' }),
    ).rejects.toMatchObject({
      code: 'process_identity_unverified',
      context: { provider: 'codex', pid: TEST_PROVIDER_PID },
    });
    expect(fake.processKill).not.toHaveBeenCalled();
    expect(fake.childKill).toHaveBeenCalledWith('SIGTERM');
    expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
    expect([...manager.admissionSnapshot().state.values()].some((entry) => entry.phase === 'live')).toBe(false);
    expect(manager.listProviderHosts().some((entry) => entry.status === 'live')).toBe(false);
    await manager.shutdown();
  });

  it('kills a coordinator-local provider spawn whose process-group probe fails', async () => {
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
      message: expect.stringContaining('is not a process-group leader'),
      context: { provider: 'codex', pid: TEST_PROVIDER_PID },
    });
    expect(fake.processKill).toHaveBeenCalledWith(-TEST_PROVIDER_PID, 0);
    expect(fake.childKill).toHaveBeenCalledWith('SIGTERM');
    expect((manager as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
    expect([...manager.admissionSnapshot().state.values()].some((entry) => entry.phase === 'live')).toBe(false);
    expect(manager.listProviderHosts().some((entry) => entry.status === 'live')).toBe(false);
    await manager.shutdown();
  });

  it('returns an admitted outcome when capacity is available', () => {
    expect(coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'))).toEqual({
      type: 'immediate',
    });
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queuePosition('job-1')).toBeNull();
  });

  it('fails closed for a runtime pool value outside the exhaustive LaunchPool set', async () => {
    const invalidPool = 'unknown-pool' as LaunchPool;
    const invariantMessage = 'Launch admission invariant violated: unknown pool "unknown-pool".';

    expect(() => coordinator.requestLaunch('intruder', 'codex', providerOwner('session'), invalidPool)).toThrow(
      invariantMessage,
    );
    expect(() => coordinator.releaseLaunch('intruder', invalidPool)).toThrow(invariantMessage);
    expect(() => coordinator.cancelQueued('intruder', invalidPool)).toThrow(invariantMessage);
    expect(() => coordinator.queueDepth(invalidPool)).toThrow(invariantMessage);
    expect(() => coordinator.queuePosition('intruder', invalidPool)).toThrow(invariantMessage);
    expect(() => coordinator.getActiveJobIds(invalidPool)).toThrow(invariantMessage);
    await expect(
      coordinator.spawnDurableJob({
        provider: 'codex',
        command: 'never-spawned',
        args: [],
        jobDir: '/never-created',
        permitGranted: true,
        pool: invalidPool,
      }),
    ).rejects.toThrow(invariantMessage);
    expect(coordinator.active).toBe(0);
    expect(coordinator.queueDepth()).toBe(0);
  });

  it('returns a queued outcome with the current position when capacity is full', () => {
    expect(coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'))).toMatchObject({
      type: 'immediate',
    });

    const queued = coordinator.requestLaunch('job-2', 'codex', providerOwner('session-2'));

    expect(queued).not.toBe('queue_full');
    expect(queued).toMatchObject({
      type: 'queued',
      queuePosition: 1,
    });
    expect(coordinator.queueDepth()).toBe(1);
    expect(coordinator.queuePosition('job-2')).toBe(1);
  });

  it('rejects duplicate job ids without exposing or mutating the incumbent reservation', async () => {
    expect(coordinator.requestLaunch('active', 'codex', providerOwner('session-active'))).toMatchObject({
      type: 'immediate',
    });
    const queued = coordinator.requestLaunch('queued', 'codex', providerOwner('session-queued'));
    if (queued === 'queue_full' || queued.type !== 'queued') throw new Error('expected queued reservation');

    expect(() => coordinator.requestLaunch('active', 'claude', providerOwner('intruder-active'), 'discuss')).toThrow(
      /reservation already exists for job active/u,
    );
    expect(() => coordinator.requestLaunch('queued', 'claude', providerOwner('intruder-queued'), 'discuss')).toThrow(
      /reservation already exists for job queued/u,
    );

    expect(coordinator.getActiveJobIds()).toEqual(['active']);
    expect(coordinator.queuePosition('queued')).toBe(1);
    expect(coordinator.getActiveJobIds('discuss')).toEqual([]);
    expect(coordinator.queueDepth('discuss')).toBe(0);

    const permit = queued.waitForPermit();
    coordinator.releaseLaunch('active');
    await permit;
    expect(coordinator.getActiveJobIds()).toEqual(['queued']);
  });

  it('tracks default and discuss pools independently', async () => {
    expect(coordinator.requestLaunch('default-1', 'codex', providerOwner('default-session-1'))).toMatchObject({
      type: 'immediate',
    });
    expect(
      coordinator.requestLaunch('discuss-1', 'codex', { kind: 'discussion', id: 'discussion-1' }, 'discuss'),
    ).toMatchObject({ type: 'immediate' });

    const queuedDefault = coordinator.requestLaunch('default-2', 'codex', providerOwner('default-session-2'));
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

    coordinator.releaseLaunch('default-1');
    await defaultPermit;
    expect(coordinator.queueDepth()).toBe(0);
    expect(coordinator.queueDepth('discuss')).toBe(1);

    coordinator.releaseLaunch('discuss-1', 'discuss');
    await discussPermit;
    expect(coordinator.queueDepth('discuss')).toBe(0);
    expect(coordinator.getActiveJobIds()).toEqual(['default-2']);
    expect(coordinator.getActiveJobIds('discuss')).toEqual(['discuss-2']);
  });

  it('returns queue_full when the internal queue limit is reached', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'))).toMatchObject({
      type: 'immediate',
    });

    for (let i = 2; i <= 21; i += 1) {
      const result = coordinator.requestLaunch(`job-${i}`, 'codex', providerOwner(`session-${i}`));
      expect(result).not.toBe('queue_full');
      if (result !== 'queue_full' && result.type === 'queued') {
        void result.waitForPermit().catch(() => null);
      }
    }

    expect(coordinator.queueDepth()).toBe(20);
    expect(coordinator.requestLaunch('job-22', 'codex', providerOwner('session-22'))).toBe('queue_full');
    await coordinator.terminateAll();
  });

  it('admits queued jobs in strict FIFO order when a launch is released', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'))).toMatchObject({
      type: 'immediate',
    });
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex', providerOwner('session-2'));
    const queuedThird = coordinator.requestLaunch('job-3', 'codex', providerOwner('session-3'));

    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    let thirdGranted = false;
    const secondPermit = queuedSecond.waitForPermit();
    const thirdPermit = queuedThird.waitForPermit().then(() => {
      thirdGranted = true;
    });

    coordinator.releaseLaunch('job-1');
    await secondPermit;
    await Promise.resolve();

    expect(thirdGranted).toBe(false);
    expect(coordinator.queuePosition('job-3')).toBe(1);

    coordinator.releaseLaunch('job-2');
    await thirdPermit;
    expect(thirdGranted).toBe(true);
    expect(coordinator.queueDepth()).toBe(0);
  });

  it('cancelQueued rejects the queued permit and advances the queue head', async () => {
    expect(coordinator.requestLaunch('job-1', 'codex', providerOwner('session-1'))).toMatchObject({
      type: 'immediate',
    });
    const queuedSecond = coordinator.requestLaunch('job-2', 'codex', providerOwner('session-2'));
    const queuedThird = coordinator.requestLaunch('job-3', 'codex', providerOwner('session-3'));

    if (queuedSecond === 'queue_full' || queuedSecond.type !== 'queued') throw new Error('expected queued job-2');
    if (queuedThird === 'queue_full' || queuedThird.type !== 'queued') throw new Error('expected queued job-3');

    const rejected = queuedSecond.waitForPermit().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(coordinator.cancelQueued('job-2')).toBe(true);
    expect((await rejected)?.message).toBe('Launch canceled while queued');

    const thirdPermit = queuedThird.waitForPermit();
    coordinator.releaseLaunch('job-1');
    await thirdPermit;
    expect(coordinator.queuePosition('job-3')).toBeNull();
  });

  it('binds queued-handle cancellation to its exact reservation generation', async () => {
    coordinator.requestLaunch('blocker-1', 'codex', providerOwner('blocker-session-1'));
    const staleHandle = coordinator.requestLaunch('reused-job', 'codex', providerOwner('old-session'));
    if (staleHandle === 'queue_full' || staleHandle.type !== 'queued') throw new Error('expected old queued handle');

    coordinator.releaseLaunch('blocker-1');
    await staleHandle.waitForPermit();
    coordinator.releaseLaunch('reused-job');

    coordinator.requestLaunch('blocker-2', 'codex', providerOwner('blocker-session-2'));
    const currentHandle = coordinator.requestLaunch('reused-job', 'codex', providerOwner('new-session'));
    if (currentHandle === 'queue_full' || currentHandle.type !== 'queued') {
      throw new Error('expected current queued handle');
    }

    expect(staleHandle.cancel()).toBe(false);
    expect(coordinator.queuePosition('reused-job')).toBe(1);

    const permit = currentHandle.waitForPermit();
    coordinator.releaseLaunch('blocker-2');
    await permit;
    expect(coordinator.getActiveJobIds()).toEqual(['reused-job']);
  });

  it('restores active and queued launches for recovery bookkeeping', async () => {
    coordinator.restoreActiveLaunch('default-1', 'codex', providerOwner('default-session-1'), 'default');
    coordinator.restoreActiveLaunch('discuss-1', 'codex', { kind: 'discussion', id: 'discussion-1' }, 'discuss');
    expect(coordinator.active).toBe(2);

    const restored = coordinator.restoreQueuedLaunch('queued-1', 'codex', providerOwner('queued-session-1'), 'default');
    expect(restored).toMatchObject({ type: 'queued', queuePosition: 1 });
    expect(coordinator.queueDepth()).toBe(1);

    const permit = restored.waitForPermit();
    coordinator.releaseLaunch('default-1');
    await permit;
    expect(coordinator.getActiveJobIds('default')).toContain('queued-1');
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
      permitGranted: true,
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

  it('reaps a live Darwin wrapper before propagating a readiness rejection', async () => {
    const base = createRealRuntime('prod');
    const incarnation = testIncarnation(7_001);
    let elapsedMs = 0n;
    let exited = false;
    const launch = vi.fn(async (options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
      options.onWrapperSpawned?.({
        runtimeRecord: {
          transport: 'durable-cli',
          pid: TEST_PROVIDER_PID,
          stdoutPath: '/tmp/readiness-rejection/stdout',
          stderrPath: '/tmp/readiness-rejection/stderr',
          startTime: new Date(0).toISOString(),
        },
        pid: TEST_PROVIDER_PID,
        leaderIncarnation: incarnation,
        signalAuthority: { pid: TEST_PROVIDER_PID, hasExited: () => exited },
      });
      throw new Error('synthetic readiness rejection');
    });
    const kill = vi.fn<ProcessPort['kill']>((pid, signal) => {
      if (signal === 0) return !exited;
      expect(pid).toBe(-TEST_PROVIDER_PID);
      exited = true;
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
        permitGranted: true,
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
    const launch = vi.fn(async (options: Parameters<Runtime['process']['durable']['launch']>[0]) => {
      options.onWrapperSpawned?.({
        runtimeRecord: {
          transport: 'durable-cli',
          pid: TEST_PROVIDER_PID,
          stdoutPath: '/tmp/provisional-readiness-rejection/stdout',
          stderrPath: '/tmp/provisional-readiness-rejection/stderr',
          startTime: new Date(0).toISOString(),
        },
        pid: TEST_PROVIDER_PID,
        leaderIncarnation: incarnation,
        signalAuthority: { pid: TEST_PROVIDER_PID, hasExited: () => false, requestTermination },
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
        if (status?.kind !== 'held') return;
        expect(identity).toEqual({
          kind: 'provisional-wrapper',
          pid: TEST_PROVIDER_PID,
          incarnation,
          processGroupId: TEST_PROVIDER_PID,
          provider: 'codex',
          jobDir: '/tmp/provisional-readiness-rejection',
        });
        expect(control?.abandon()).toBe(true);
      },
    );

    await expect(
      localCoordinator.spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/provisional-readiness-rejection',
        permitGranted: true,
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
      permitGranted: true,
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

  it('publishes a durable hold and makes abort an explicit abandonment without absence proof', async () => {
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
              signalAuthority: { pid: TEST_PROVIDER_PID, hasExited: () => true },
            };
          },
          waitForExit: async () => ({ exitCode: 0, signal: null, endTime: new Date(1).toISOString() }),
        },
      },
    };
    const localCoordinator = new LaunchCoordinator({ runtime });
    const abort = new AbortController();
    const holdControls: DurableContainmentOperatorControl[] = [];
    const observations = vi.fn(
      (
        _identity: DurableCliProcessSubject | DurableProvisionalProcessSubject,
        _status?: DurableContainmentStatus,
        control?: DurableContainmentOperatorControl,
      ) => {
        if (control !== undefined) holdControls.push(control);
      },
    );
    const spawn = localCoordinator.spawnDurableJob({
      provider: 'codex',
      command: 'codex',
      args: ['exec'],
      jobDir: '/tmp/held-result',
      permitGranted: true,
      signal: abort.signal,
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
    abort.abort();
    const holdControl = holdControls.at(-1);
    if (holdControl === undefined) throw new Error('Expected durable containment abandonment control');
    holdControl.abandon();

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
          throw new Error('synthetic absence publication failure');
        }
      },
    );
    let settled = false;
    const spawn = localCoordinator
      .spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/failed-absence-publication',
        permitGranted: true,
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
    await retainedCleanup();

    expect(absencePublicationAttempts).toBe(1);
    expect(cleanupOwnership.cleanupHandles.size).toBe(1);
    expect(cleanupOwnership.cleanupRetentions.size).toBe(1);
    expect(clearInterval).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    expect(holdControl?.abandon()).toBe(true);
    resolveExit(exitRecord);
    await expect(spawn).resolves.toMatchObject({ code: 0, aborted: true });
    expect(clearInterval).toHaveBeenCalledWith(retryHandle);
  });

  it('refuses new admission after shutdown begins', async () => {
    await expect(coordinator.terminateAll()).resolves.toEqual({ kind: 'all-observed-absent' });

    expect(() => coordinator.requestLaunch('late-job', 'codex', providerOwner('late-session'))).toThrow(
      'Launch rejected because shutdown has begun',
    );
    await expect(
      coordinator.spawnDurableJob({
        provider: 'codex',
        command: 'codex',
        args: ['exec'],
        jobDir: '/tmp/sim/jobs/late-job',
        permitGranted: true,
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
