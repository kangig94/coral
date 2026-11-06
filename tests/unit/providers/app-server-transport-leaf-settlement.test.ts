import type { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { FailureDomainContainment, FailureDomainObservation } from '#src/infra/failure-domain.js';
import { spawnProviderServerTransport } from '#src/providers/app-server-transport.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { providerCustodyTicket } from '#tests/helpers/provider-custody.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

async function hostWithLeaf(
  options: {
    runtime?: SimulationRuntime;
    bind?: boolean;
    firstProbeNull?: boolean;
    allProbesNull?: boolean;
    unboundIntent?: boolean;
    start?: boolean;
    entered?: boolean;
    detached?: boolean;
    initialObservation?: FailureDomainObservation;
  } = {},
) {
  const runtime = options.runtime ?? new SimulationRuntime();
  let observation: FailureDomainObservation = options.initialObservation ?? { kind: 'populated' };
  const kill = vi.fn<FailureDomainContainment['kill']>(() => ({ kind: 'entered' }));
  const domain = { observe: vi.fn(() => observation), kill };
  vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue(domain);
  let exit!: () => void;
  let started!: () => void;
  let placed!: () => void;
  let absent!: () => void;
  let exitOnly!: () => void;
  let closePipes!: () => void;
  runtime.spawner.enqueueSpawn({
    close: null,
    kills: [{ signal: 'default', delayMs: 100_000 }],
    onSpawn: (context) => {
      if (options.bind !== false || options.unboundIntent === true) {
        const ticket = JSON.parse(providerCustodyTicket) as {
          runDir: string;
          intentId: string;
          processToken: string;
          epoch: string;
        };
        const dir = `${ticket.runDir}/custody.v1/${ticket.intentId}`;
        runtime.storage.mkdirSync(dir, { recursive: true });
        runtime.storage.writeAtomicSync(
          `${dir}/intent.v1.json`,
          JSON.stringify({
            version: 'v1',
            id: ticket.intentId,
            effect: 'process-spawn',
            owner: 'provider-host',
            operationId: 'test',
            epoch: ticket.epoch,
            processToken: ticket.processToken,
            capsule: null,
            createdAtMs: 0,
            bindDeadlineMs: 100_000,
          }),
        );
        if (options.bind !== false)
          runtime.storage.writeAtomicSync(
            `${dir}/binding.v1.json`,
            JSON.stringify({
              version: 'v1',
              intentId: ticket.intentId,
              processToken: ticket.processToken,
              operationId: 'test',
              process: {
                pid: context.child.pid,
                incarnation: runtime.process.readProcessIncarnation(context.child.pid!, 'linux'),
                processGroupId: context.child.pid,
              },
              capsule: null,
              observedAtMs: 0,
            }),
          );
      }
      if (options.allProbesNull) vi.spyOn(runtime.process, 'readProcessIncarnation').mockReturnValue(null);
      if (options.firstProbeNull) vi.spyOn(runtime.process, 'readProcessIncarnation').mockReturnValueOnce(null);
      exit = () => context.close({ code: 0 });
      exitOnly = () => (context.child as unknown as EventEmitter).emit('exit', 0, null);
      closePipes = () => (context.child as unknown as EventEmitter).emit('close', 0, null);
      placed = () =>
        (context.child as unknown as EventEmitter).emit('message', {
          kind: 'provider-host-placed',
          processToken: JSON.parse(providerCustodyTicket).processToken as string,
        });
      absent = () =>
        (context.child as unknown as EventEmitter).emit('message', {
          kind: 'provider-host-absent',
          processToken: JSON.parse(providerCustodyTicket).processToken as string,
        });
      started = () => {
        if (options.entered !== false) placed();
        (context.child as unknown as EventEmitter).emit('message', {
          kind: 'provider-host-started',
          processToken: JSON.parse(providerCustodyTicket).processToken as string,
          pid: 4242,
          incarnation: testIncarnation(1),
        });
      };
    },
  });
  const params = {
    runtime,
    generation: 1,
    options: {
      provider: 'test',
      command: 'fake-provider',
      args: [],
      custodyTicket: providerCustodyTicket,
      failureDomainName: 'host-test',
    },
    observeProviderResponse: () => {},
    acceptFailedSpawnCleanup: (
      hold: Parameters<Parameters<typeof spawnProviderServerTransport>[0]['acceptFailedSpawnCleanup']>[0],
    ) => ({
      kind: 'accepted' as const,
      owner: 'provider-proxy-root-pool' as const,
      settlement: hold.settled,
    }),
  };
  const handle =
    options.detached === true
      ? await spawnProviderServerTransport({ ...params, detached: true })
      : await spawnProviderServerTransport({ ...params, detached: false });
  if ('kind' in handle) throw handle.error;
  if (options.start !== false) started();
  const childKill = vi.spyOn(handle.child, 'kill');
  const close = () =>
    handle.close((hold) => ({ kind: 'accepted', owner: 'provider-proxy-root-pool', settlement: hold.settled }));
  return {
    runtime,
    handle,
    childKill,
    exit,
    exitOnly,
    placed,
    absent,
    closePipes,
    close,
    kill,
    domain,
    setObservation: (value: FailureDomainObservation) => {
      observation = value;
    },
  };
}

it('retains decisive cessation after housekeeping removes the leaf', async () => {
  const host = await hostWithLeaf();
  host.setObservation({ kind: 'absent' });
  host.exit();
  await host.handle.processCessation;
  expect((await host.close()).kind).toBe('observed-absent');
  host.setObservation({ kind: 'missing' });
  expect((await host.close()).kind).toBe('observed-absent');
  expect((await host.close()).kind).toBe('observed-absent');
  expect(host.kill).not.toHaveBeenCalled();
});

it('does not reclaim an observed leaf in an aborted or abandoned cleanup retry', async () => {
  const host = await hostWithLeaf();
  host.exit();
  const held = await host.close();
  if (held.kind !== 'held-unobservable' && held.kind !== 'held-alive')
    throw new Error(`Expected hold, got ${held.kind}`);
  const killedBeforeRetry = host.kill.mock.calls.length;
  const processesBeforeRetry = host.runtime.spawner.killCalls.length;
  const aborted = await held.retry(AbortSignal.abort());
  expect(aborted.kind).toBe('held-unobservable');
  expect(host.kill).toHaveBeenCalledTimes(killedBeforeRetry);
  expect(host.runtime.spawner.killCalls).toHaveLength(processesBeforeRetry);
  await held.operatorExit.abandon();
  expect((await held.retry()).kind).toBe('operator-abandoned');
  expect((await host.close()).kind).toBe('operator-abandoned');
  expect(host.kill).toHaveBeenCalledTimes(killedBeforeRetry);
  expect(host.runtime.spawner.killCalls).toHaveLength(processesBeforeRetry);
});

it('holds when the leaf disappears before decisive cessation', async () => {
  const host = await hostWithLeaf();
  host.exit();
  const held = await host.close();
  if (held.kind !== 'held-unobservable' && held.kind !== 'held-alive')
    throw new Error(`Expected hold, got ${held.kind}`);
  host.setObservation({ kind: 'missing' });
  expect((await held.retry()).kind).toBe('held-unobservable');
});

it('retains a populated observation made only while deciding to reclaim the leaf', async () => {
  const host = await hostWithLeaf({ initialObservation: { kind: 'missing' } });
  vi.spyOn(host.runtime.storage, 'readFileSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('temporarily unreadable custody binding'), { code: 'EACCES' });
  });
  host.domain.observe
    .mockReturnValueOnce({ kind: 'missing' })
    .mockReturnValueOnce({ kind: 'populated' })
    .mockReturnValue({ kind: 'missing' });
  let settled = false;
  void host.handle.processCessation.then(() => {
    settled = true;
  });
  host.exit();
  expect(host.kill).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect((await host.close()).kind).toBe('held-unobservable');
  expect(settled).toBe(false);
});

it('returns the same decisive result through a retained retry after leaf removal', async () => {
  const host = await hostWithLeaf();
  host.exit();
  const held = await host.close();
  if (held.kind !== 'held-unobservable' && held.kind !== 'held-alive')
    throw new Error(`Expected hold, got ${held.kind}`);
  host.setObservation({ kind: 'absent' });
  expect((await held.retry()).kind).toBe('observed-absent');
  let settled = false;
  void host.handle.processCessation.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(true);
  host.setObservation({ kind: 'missing' });
  const kills = host.kill.mock.calls.length;
  expect((await held.retry()).kind).toBe('observed-absent');
  expect((await host.close()).kind).toBe('observed-absent');
  expect(host.kill).toHaveBeenCalledTimes(kills);
});

it('does not signal a still-live wrapper when close is repeated after abandonment', async () => {
  const host = await hostWithLeaf();
  const held = await host.close();
  if (held.kind !== 'held-alive' && held.kind !== 'held-unobservable')
    throw new Error(`Expected hold, got ${held.kind}`);
  const childKills = host.childKill.mock.calls.length;
  const leafKills = host.kill.mock.calls.length;
  expect(childKills).toBeGreaterThan(0);
  await held.operatorExit.abandon();
  expect((await host.close()).kind).toBe('operator-abandoned');
  expect(host.childKill).toHaveBeenCalledTimes(childKills);
  expect(host.kill).toHaveBeenCalledTimes(leafKills);
});

it('reclaims on wrapper exit and keeps cessation pending after cleanup while stdout remains open', async () => {
  const host = await hostWithLeaf();
  host.placed();
  host.kill.mockImplementation(() => {
    host.setObservation({ kind: 'absent' });
    return { kind: 'entered' };
  });
  let settled = false;
  void host.handle.processCessation.then(() => {
    settled = true;
  });
  host.exitOnly();
  expect(host.kill).toHaveBeenCalledTimes(1);
  const cleanup = await host.close();
  expect(settled).toBe(false);
  expect(['held-alive', 'held-unobservable']).toContain(cleanup.kind);
  host.closePipes();
  await host.handle.processCessation;
  expect(settled).toBe(true);
});

it('does not reclaim the first host leaf when a second wrapper reuses its bound ticket', async () => {
  const first = await hostWithLeaf();
  const second = await hostWithLeaf({ runtime: first.runtime, bind: false });
  expect(first.handle.pid).not.toBe(second.handle.pid);
  second.exit();
  const disposition = await second.close();
  expect(disposition.kind).toBe('held-unobservable');
  expect(second.kill).not.toHaveBeenCalled();
  expect(first.kill).not.toHaveBeenCalled();
  expect(first.runtime.process.observeLiveness(first.handle.pid)).toBe('alive');
});

it('recovers wrapper ownership after a transient first incarnation probe failure', async () => {
  const host = await hostWithLeaf({ firstProbeNull: true });
  host.kill.mockImplementation(() => {
    host.setObservation({ kind: 'absent' });
    return { kind: 'entered' };
  });
  const probe = vi.mocked(host.runtime.process.readProcessIncarnation);
  expect(probe.mock.results[0]?.value).toBeNull();
  host.exit();
  expect(host.kill).toHaveBeenCalledTimes(1);
  await host.handle.processCessation;
  expect((await host.close()).kind).toBe('observed-absent');
});

it('does not recover unknown ownership from a numeric pid after the wrapper exited', async () => {
  const host = await hostWithLeaf({ firstProbeNull: true, start: false });
  const probe = vi.mocked(host.runtime.process.readProcessIncarnation);
  host.exit();
  expect((await host.close()).kind).toBe('held-unobservable');
  expect(host.kill).not.toHaveBeenCalled();
  expect(probe).toHaveBeenCalledTimes(1);
});

it('settles a placed host killed before reporting its provider identity after reclaiming the populated tree', async () => {
  const host = await hostWithLeaf({ start: false });
  host.placed();
  host.kill.mockImplementation(() => {
    host.setObservation({ kind: 'absent' });
    return { kind: 'entered' };
  });
  host.exit();
  expect((await host.close()).kind).toBe('observed-absent');
  await host.handle.processCessation;
  expect(host.kill).toHaveBeenCalledOnce();
  expect((await host.close()).kind).toBe('observed-absent');
});

it('does not infer provider absence from an empty leaf when wrapper entry was refused', async () => {
  const host = await hostWithLeaf({ start: false });
  host.kill.mockImplementation(() => {
    host.setObservation({ kind: 'absent' });
    return { kind: 'entered' };
  });
  host.exit();
  let settled = false;
  void host.handle.processCessation.then(() => {
    settled = true;
  });
  expect((await host.close()).kind).toBe('held-unobservable');
  expect(settled).toBe(false);
  host.absent();
  await host.handle.processCessation;
  expect((await host.close()).kind).toBe('observed-absent');
});

it('settles exited unbound startup that reported no provider despite unavailable incarnation probes', async () => {
  const host = await hostWithLeaf({
    bind: false,
    unboundIntent: true,
    allProbesNull: true,
    start: false,
    initialObservation: { kind: 'absent' },
  });
  host.absent();
  host.exit();
  expect((await host.close()).kind).toBe('observed-absent');
  await host.handle.processCessation;
  expect(host.kill).not.toHaveBeenCalled();
  expect((await host.close()).kind).toBe('observed-absent');
});

it('does not treat another wrapper binding as an unbound startup even after an absence message', async () => {
  const first = await hostWithLeaf();
  const second = await hostWithLeaf({
    runtime: first.runtime,
    bind: false,
    allProbesNull: true,
    start: false,
    initialObservation: { kind: 'absent' },
  });
  second.absent();
  second.exit();
  expect((await second.close()).kind).toBe('held-unobservable');
  expect(second.kill).not.toHaveBeenCalled();
  expect(first.runtime.process.observeLiveness(first.handle.pid)).toBe('alive');
});

it('does not infer unbound startup from an absent or unreadable custody record', async () => {
  const host = await hostWithLeaf({
    bind: false,
    allProbesNull: true,
    start: false,
    initialObservation: { kind: 'absent' },
  });
  host.absent();
  host.exit();
  expect((await host.close()).kind).toBe('held-unobservable');
  expect(host.kill).not.toHaveBeenCalled();
});

it('retains initial population evidence when a placed host exits with its tree already empty', async () => {
  const host = await hostWithLeaf({ start: false });
  host.placed();
  host.setObservation({ kind: 'absent' });
  host.exit();
  expect((await host.close()).kind).toBe('observed-absent');
  await host.handle.processCessation;
  expect(host.kill).not.toHaveBeenCalled();
  expect((await host.close()).kind).toBe('observed-absent');
});

it('settles a placed bound wrapper when an outer reaper emptied the leaf before any populated observation', async () => {
  const host = await hostWithLeaf({ start: false, initialObservation: { kind: 'missing' } });
  host.placed();
  host.setObservation({ kind: 'absent' });
  host.exit();
  expect((await host.close()).kind).toBe('observed-absent');
  await host.handle.processCessation;
  expect(host.kill).not.toHaveBeenCalled();
});

it('uses group evidence instead of an empty leaf when the host never entered it', async () => {
  const host = await hostWithLeaf({ detached: true, entered: false, initialObservation: { kind: 'absent' } });
  const liveness = host.runtime.process.observeLiveness.bind(host.runtime.process);
  let groupAlive = true;
  vi.spyOn(host.runtime.process, 'observeLiveness').mockImplementation((pid) =>
    pid === -host.handle.pid ? (groupAlive ? 'alive' : 'absent') : liveness(pid),
  );
  host.absent();
  host.exit();
  const held = await host.close();
  expect(held.kind).toBe('held-unobservable');
  let settled = false;
  void host.handle.processCessation.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  groupAlive = false;
  host.closePipes();
  await host.handle.processCessation;
  expect(settled).toBe(true);
});
