import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import type * as ProviderTransport from '#src/providers/app-server-transport.js';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), nextToken: 0 }));
vi.mock('#src/providers/app-server-transport.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  spawnProviderServerTransport: boundary.spawn,
}));
vi.mock('#src/infra/custody-process-ticket.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  recordChildRoleCustodyIntent: () => ({
    runDir: '/fixture/run',
    intentId: '00000000-0000-4000-8000-000000000001',
    processToken: `00000000-0000-4000-8000-${String(++boundary.nextToken).padStart(12, '0')}`,
    processGroupId: null,
    epoch: '1',
  }),
}));

beforeEach(() => {
  boundary.spawn.mockReset();
  boundary.nextToken = 0;
});

function createHarness() {
  const runtime = new SimulationRuntime({ env: { CORAL_CUSTODY_EPOCH: '1' } });
  const root = '/owned-namespace';
  Object.defineProperty(runtime.process, 'failureDomainRoot', { value: { kind: 'placed', root } });
  const create = vi.spyOn(runtime.process, 'createFailureDomain').mockImplementation((name) => ({
    kind: 'created',
    path: `${root}/${name}`,
  }));
  const remove = vi.spyOn(runtime.process, 'removeFailureDomain').mockReturnValue({ kind: 'removed' });
  const authority = createProxyAppServerHostAuthority(runtime, 'set-id');
  let attempt = 0;
  const open = (signal?: AbortSignal) => {
    const scope = authority.beginOperation({ jobId: `job-${++attempt}`, operationId: `operation-${attempt}` });
    scope.selectCancellationMode('shared-acknowledged-interrupt');
    return scope.openSession(
      {
        provider: 'codex',
        command: 'fake-provider',
        args: [],
        cwd: fixtureCanonicalWorkDir(process.cwd()),
        leaseMode: 'shared',
        idleRetirement: 'unleased',
      },
      { signal },
    );
  };
  return { authority, create, remove, open, root };
}

describe('failed provider startup leaf cleanup', () => {
  it.each(['aborted', 'failed'] as const)('removes each empty leaf after %s startup', async (failure) => {
    const harness = createHarness();
    const controller = new AbortController();
    if (failure === 'aborted') {
      const actual = await vi.importActual<typeof ProviderTransport>('#src/providers/app-server-transport.js');
      boundary.spawn.mockImplementation(actual.spawnProviderServerTransport);
      controller.abort();
    } else boundary.spawn.mockRejectedValue(new Error('transport startup failed'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(harness.open(controller.signal)).rejects.toThrow(
        failure === 'aborted' ? /abort/i : 'transport startup failed',
      );
    }
    expect(harness.create).toHaveBeenCalledTimes(3);
    expect(harness.remove.mock.calls.map(([path]) => path)).toEqual(
      harness.create.mock.calls.map(([name]) => `${harness.root}/${name}`),
    );
    expect(new Set(harness.remove.mock.calls.map(([path]) => path)).size).toBe(3);
  });

  it('does not attempt removal when leaf creation is refused', async () => {
    const harness = createHarness();
    harness.create.mockReturnValue({ kind: 'refused', errno: 'EACCES' });
    boundary.spawn.mockRejectedValue(new Error('transport startup failed'));
    await expect(harness.open()).rejects.toThrow('transport startup failed');
    expect(harness.remove).not.toHaveBeenCalled();
  });

  it.each(['removed', 'populated'] as const)(
    'retains process cleanup ownership despite a %s leaf and retries removal after settlement',
    async (leafState) => {
      const harness = createHarness();
      harness.remove.mockReturnValue(
        leafState === 'populated' ? { kind: 'refused', errno: 'EBUSY' } : { kind: 'removed' },
      );
      let resolve!: () => void;
      const settled = new Promise<void>((done) => {
        resolve = done;
      });
      const subject = { kind: 'process', pid: 4242 } as const;
      const error = new Error('provider startup cleanup held');
      const abandon = vi.fn(async () => {
        throw new Error('Unexpected abandonment');
      });
      const hold: ProviderTransport.ProviderServerFailedSpawnCleanupHold = {
        kind: 'held-unobservable',
        subject,
        observation: 'unobservable',
        error,
        settled,
        operatorExit: { kind: 'abandon-provider-host-acquisition', abandon },
        retry: async () => ({ kind: 'observed-absent', evidence: { subject } }),
      };
      let acceptance: ProviderTransport.ProviderServerFailedSpawnCleanupAcceptance | undefined;
      boundary.spawn.mockImplementation(
        async (params: Parameters<typeof ProviderTransport.spawnProviderServerTransport>[0]) => {
          acceptance = params.acceptFailedSpawnCleanup(hold);
          return { ...hold, successor: acceptance };
        },
      );
      await expect(harness.open()).rejects.toThrow(error);
      const createdPath = `${harness.root}/${harness.create.mock.calls[0][0]}`;
      expect(harness.remove).toHaveBeenCalledExactlyOnceWith(createdPath);
      expect(harness.authority.admissionSnapshot().state.size).toBe(1);
      expect(harness.authority.admissionSnapshot().tombstones).toHaveLength(0);
      expect(abandon).not.toHaveBeenCalled();
      expect(acceptance?.kind).toBe('accepted');
      harness.remove.mockReturnValue({ kind: 'removed' });
      resolve();
      await acceptance!.settlement;
      expect(harness.remove).toHaveBeenCalledTimes(2);
      expect(harness.remove).toHaveBeenLastCalledWith(createdPath);
      expect(harness.authority.admissionSnapshot().state.size).toBe(0);
    },
  );
});
