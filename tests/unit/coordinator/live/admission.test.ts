import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { DefaultProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import type { LaunchPool } from '#src/jobs/contracts/admission.js';
import { canProbeProcessStartedAtSeconds } from '#src/infra/node-process.js';
import type { ChildProcessLike } from '#src/infra/port-types.js';
import type { ProcessPort, Runtime, RuntimeSpawnOptions } from '#src/runtime/ports.js';
import {
  canSignalProviderHostProcessGroup,
  ProviderHostUnsupportedPlatformError,
} from '#src/providers/host-admission.js';
import { createExclusiveSpec } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

const ORIGINAL_MAX_CHILDREN = process.env.CORAL_MAX_WORKERS;
const ORIGINAL_DISCUSS_MAX_CHILDREN = process.env.CORAL_DISCUSS_MAX_WORKERS;
const TEST_PROVIDER_PID = 20_000;
const TEST_PROVIDER_STARTED_AT_SECONDS = 1_700_000_000;

const PLATFORM_CAPABILITIES = {
  aix: { canProbeStartTime: false, canSignalProcessGroup: true },
  android: { canProbeStartTime: false, canSignalProcessGroup: true },
  cygwin: { canProbeStartTime: false, canSignalProcessGroup: true },
  darwin: { canProbeStartTime: true, canSignalProcessGroup: true },
  freebsd: { canProbeStartTime: false, canSignalProcessGroup: true },
  haiku: { canProbeStartTime: false, canSignalProcessGroup: true },
  linux: { canProbeStartTime: true, canSignalProcessGroup: true },
  netbsd: { canProbeStartTime: false, canSignalProcessGroup: true },
  openbsd: { canProbeStartTime: false, canSignalProcessGroup: true },
  sunos: { canProbeStartTime: false, canSignalProcessGroup: true },
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
  processStartedAtSeconds: number | null = TEST_PROVIDER_STARTED_AT_SECONDS,
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
  const isAlive = vi.fn<ProcessPort['isAlive']>((targetPid) => {
    if (Math.abs(targetPid) !== pid) return false;
    return targetPid < 0 ? groupAlive : processAlive;
  });
  const readProcessStartedAtSeconds = vi.fn<ProcessPort['readProcessStartedAtSeconds']>((targetPid) =>
    targetPid === pid && processAlive ? processStartedAtSeconds : null,
  );
  const readPlatform = vi.fn(() => platform);
  return {
    runtime: {
      ...base,
      env: { ...base.env, platform: readPlatform },
      process: { ...base.process, spawn, kill: processKill, isAlive, readProcessStartedAtSeconds },
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
      processStartedAtSeconds: TEST_PROVIDER_STARTED_AT_SECONDS,
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
      expect(canProbeProcessStartedAtSeconds(platform)).toBe(capabilities.canProbeStartTime);
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

  it('kills a coordinator-local provider spawn whose start time cannot be read', async () => {
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

  it('kills a coordinator-local provider spawn when reading its start time throws', async () => {
    const fake = createProviderProcessRuntime(TEST_PROVIDER_PID);
    const runtime: Runtime = {
      ...fake.runtime,
      process: {
        ...fake.runtime.process,
        readProcessStartedAtSeconds: () => {
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

  it('returns queue_full when the internal queue limit is reached', () => {
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
    coordinator.terminateAll();
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
});
