import { SIGTERM_GRACE_MS, SIGKILL_GRACE_MS } from '#src/infra/process-constants.js';
import type { EventEmitter } from 'node:events';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { expect, it, vi } from 'vitest';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { PROVIDER_CONTAINMENT_ACCEPTED, spawnProviderServerTransport } from '#src/providers/app-server-transport.js';
import { enqueueProviderHost, providerCustodyTicket } from '#tests/helpers/provider-custody.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

it('places a detached local custodian in the token leaf with exact provider env and removes the empty leaf on close', async () => {
  const runtime = new SimulationRuntime();
  const root = '/test-namespace';
  const token = JSON.parse(providerCustodyTicket).processToken as string;
  const path = `${root}/host-${token}`;
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root } });
  const create = vi.spyOn(runtime.process, 'createFailureDomain').mockReturnValue({ kind: 'created', path });
  const remove = vi.spyOn(runtime.process, 'removeFailureDomain');
  enqueueProviderHost(runtime, { close: null });
  const coordinator = new LaunchCoordinator({ runtime });
  const handle = await coordinator.spawnProviderServer(
    {
      provider: 'test',
      command: 'fixture',
      args: ['serve'],
      custodyTicket: providerCustodyTicket,
      exactEnv: { ONLY: 'provider' },
    },
    undefined,
    undefined,
    undefined,
    (hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }),
  );
  if ('kind' in handle) throw handle.error;
  expect(create).toHaveBeenCalledWith(`host-${token}`, true);
  expect(runtime.spawner.spawnCalls[0]).toMatchObject({
    command: process.execPath,
    args: expect.arrayContaining(['--provider-host', 'fixture', 'serve', `--coral-custody-token=${token}`]),
    ipc: true,
    detached: true,
    env: {
      ONLY: 'provider',
      CORAL_FAILURE_DOMAIN_ROOT: root,
      CORAL_FAILURE_DOMAIN: path,
      CORAL_CUSTODY_PROCESS_TICKET: providerCustodyTicket,
    },
  });
  await handle.close((hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }));
  expect(remove).toHaveBeenCalledWith(path);
});

it('refuses custody-less transport spawning before creating a process', async () => {
  const runtime = new SimulationRuntime();
  await expect(
    spawnProviderServerTransport({
      runtime,
      options: { provider: 'test', command: 'fixture', args: [] },
      generation: 1,
      observeProviderResponse: () => {},
      acceptFailedSpawnCleanup: (hold) => ({
        kind: 'accepted',
        owner: 'provider-host-manager',
        settlement: hold.settled,
      }),
    }),
  ).rejects.toThrow('requires a custody ticket');
  expect(runtime.spawner.spawnCalls).toHaveLength(0);
});

it.each(['running', 'initializing'])(
  'removes the local leaf after custodian cessation without an absence receipt when an error closes the %s transport first',
  async (phase) => {
    const runtime = new SimulationRuntime();
    const path = `/test-namespace/host-${JSON.parse(providerCustodyTicket).processToken as string}`;
    Object.defineProperty(runtime.process, 'failureDomainRoot', {
      value: { kind: 'placed', root: '/test-namespace' },
    });
    vi.spyOn(runtime.process, 'createFailureDomain').mockReturnValue({ kind: 'created', path });
    let populated = true;
    let leafExists = true;
    const remove = vi.spyOn(runtime.process, 'removeFailureDomain').mockImplementation(() => {
      if (populated) return { kind: 'refused', errno: 'EBUSY' };
      leafExists = false;
      return { kind: 'removed' };
    });
    let fail!: () => void;
    let exit!: () => void;
    runtime.spawner.enqueueSpawn({
      close: null,
      kills: [{ signal: 'default', delayMs: 100_000 }],
      onSpawn: (context) => {
        fail = () => (context.child as unknown as EventEmitter).emit('error', new Error('custodian I/O error'));
        exit = () => {
          populated = false;
          context.close({ code: 1 });
        };
      },
    });
    const recordContainment = vi.fn<() => typeof PROVIDER_CONTAINMENT_ACCEPTED>(() => PROVIDER_CONTAINMENT_ACCEPTED);
    const coordinator = new LaunchCoordinator({ runtime });
    const spawn = coordinator.spawnProviderServer(
      {
        provider: 'test',
        command: 'fixture',
        args: [],
        custodyTicket: providerCustodyTicket,
        ...(phase === 'initializing' ? { initializeRequest: { method: 'initialize', params: {} } } : {}),
      },
      undefined,
      undefined,
      recordContainment,
      (hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }),
    );
    const result = spawn.catch((error: unknown) => error);
    await flushMicrotasks();
    expect(recordContainment).toHaveBeenCalledOnce();
    const handle = phase === 'running' ? await spawn : null;
    fail();
    if (handle !== null) {
      if ('kind' in handle) throw handle.error;
      await expect(handle.closePromise).resolves.toBeInstanceOf(Error);
    } else {
      await expect(result).resolves.toBeInstanceOf(Error);
    }
    expect(leafExists).toBe(true);
    const attemptsBeforeExit = remove.mock.calls.length;
    exit();
    await flushMicrotasks();
    expect(remove).toHaveBeenCalledTimes(attemptsBeforeExit + 1);
    expect(remove).toHaveBeenLastCalledWith(path);
    expect(leafExists).toBe(false);
  },
);

it('sweeps a receipt-less failed-spawn leaf after its accepted hold settles by group absence', async () => {
  const runtime = new SimulationRuntime();
  const path = `/test-namespace/host-${JSON.parse(providerCustodyTicket).processToken as string}`;
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root: '/test-namespace' } });
  vi.spyOn(runtime.process, 'createFailureDomain').mockReturnValue({ kind: 'created', path });
  let groupAlive = true;
  vi.spyOn(runtime.process, 'observeLiveness').mockImplementation((pid) =>
    pid < 0 && groupAlive ? 'alive' : 'absent',
  );
  let exists = true;
  let leafPopulated = true;
  const remove = vi.spyOn(runtime.process, 'removeFailureDomain').mockImplementation(() => {
    if (leafPopulated) return { kind: 'refused', errno: 'EBUSY' };
    exists = false;
    return { kind: 'removed' };
  });
  vi.spyOn(runtime.process, 'sweepHostFailureDomains').mockImplementation((owned) => {
    if (!owned.has(path) && exists) void runtime.process.removeFailureDomain(path);
  });
  let exit!: () => void;
  runtime.spawner.enqueueSpawn({
    close: null,
    kills: [{ signal: 'default', delayMs: 100_000 }],
    onSpawn: (context) => {
      exit = () => context.close({ code: 1 });
    },
  });
  const coordinator = new LaunchCoordinator({ runtime });
  const launch = coordinator.spawnProviderServer(
    { provider: 'test', command: 'fixture', args: [], custodyTicket: providerCustodyTicket },
    undefined,
    undefined,
    () => {
      throw new Error('containment recording failed');
    },
    (hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }),
  );
  await flushMicrotasks();
  runtime.time.tick(SIGTERM_GRACE_MS);
  await flushMicrotasks();
  runtime.time.tick(SIGKILL_GRACE_MS);
  const hold = await launch;
  if (!('kind' in hold)) throw new Error('expected accepted cleanup hold');
  exit();
  await flushMicrotasks();
  expect(exists).toBe(true);
  groupAlive = false;
  const cleanup = hold.retry();
  runtime.time.tick(SIGTERM_GRACE_MS);
  await expect(cleanup).resolves.toMatchObject({ kind: 'observed-absent' });
  await hold.settled;
  expect(exists).toBe(true);
  leafPopulated = false;
  vi.mocked(runtime.process.observeLiveness).mockRestore();
  vi.mocked(runtime.process.createFailureDomain).mockReturnValue({ kind: 'refused', errno: 'EPERM' });
  runtime.spawner.enqueueSpawn({ close: null });
  await coordinator.spawnProviderServer(
    { provider: 'test', command: 'fixture', args: [], custodyTicket: providerCustodyTicket },
    undefined,
    undefined,
    undefined,
    (next) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: next.settled }),
  );
  expect(remove).toHaveBeenCalledWith(path);
  expect(exists).toBe(false);
});

it('protects a local leaf from sweeping during overlapping placement', async () => {
  const runtime = new SimulationRuntime();
  const root = '/test-namespace';
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root } });
  const ownedAtSweep: ReadonlySet<string>[] = [];
  const sweep = vi.spyOn(runtime.process, 'sweepHostFailureDomains').mockImplementation((owned) => {
    ownedAtSweep.push(new Set(owned));
  });
  vi.spyOn(runtime.process, 'createFailureDomain').mockImplementation((name) => {
    return { kind: 'created', path: `${root}/${name}` };
  });
  runtime.spawner.enqueueSpawn({ close: null });
  const coordinator = new LaunchCoordinator({ runtime });
  const options = { provider: 'test', command: 'fixture', args: [], custodyTicket: providerCustodyTicket };
  const first = coordinator.spawnProviderServer(options, undefined, undefined, undefined, (hold) => ({
    kind: 'accepted',
    owner: 'provider-host-manager',
    settlement: hold.settled,
  }));
  const token = JSON.parse(providerCustodyTicket).processToken as string;
  runtime.spawner.enqueueSpawn({ close: null });
  const secondTicket = JSON.stringify({
    ...JSON.parse(providerCustodyTicket),
    processToken: '00000000-0000-4000-8000-000000000003',
  });
  await coordinator.spawnProviderServer(
    { ...options, custodyTicket: secondTicket },
    undefined,
    undefined,
    undefined,
    (hold) => ({ kind: 'accepted', owner: 'provider-host-manager', settlement: hold.settled }),
  );
  await first;
  expect(sweep).toHaveBeenCalledTimes(2);
  expect(ownedAtSweep[1]?.has(`${root}/host-${token}`)).toBe(true);
});
