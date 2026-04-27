import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BackendDiscoveryModule from '#src/infra/coordinator-discovery.js';
import type * as IpcClientModule from '#src/transport/ipc/client.js';
import type { CoordinatorDiscoveryRecord } from '#src/infra/coordinator-discovery.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  readDiscoveryRecord: vi.fn<(runtime: unknown) => CoordinatorDiscoveryRecord | null>(),
  createIpcClient: vi.fn(),
}));

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

vi.mock('#src/infra/coordinator-discovery.js', async () => {
  const actual = await vi.importActual<typeof BackendDiscoveryModule>('#src/infra/coordinator-discovery.js');
  return {
    ...actual,
    readDiscoveryRecord: mockState.readDiscoveryRecord,
  };
});

vi.mock('#src/transport/ipc/client.js', async () => {
  const actual = await vi.importActual<typeof IpcClientModule>('#src/transport/ipc/client.js');
  return {
    ...actual,
    createIpcClient: mockState.createIpcClient,
  };
});

import { createCliExpansionActivation } from '#src/cli/expansion-activation.js';

function makeDiscoveryRecord(overrides: Partial<CoordinatorDiscoveryRecord> = {}): CoordinatorDiscoveryRecord {
  return {
    pid: 1234,
    port: 4312,
    socketPath: '/tmp/coral.sock',
    bundleHash: 'bundle-a',
    flavor: 'prod',
    namespace: 'ns-a',
    startedAt: 1_713_456_789_000,
    token: 'token-a',
    ...overrides,
  };
}

describe('expansion activation', () => {
  const originalFlavor = process.env.CORAL_FLAVOR;

  beforeEach(() => {
    mockState.ensure.mockReset();
    mockState.readDiscoveryRecord.mockReset();
    mockState.createIpcClient.mockReset();
    delete process.env.CORAL_FLAVOR;
  });

  afterEach(() => {
    if (originalFlavor === undefined) {
      delete process.env.CORAL_FLAVOR;
    } else {
      process.env.CORAL_FLAVOR = originalFlavor;
    }
  });

  it('activates expansions through ensure-backed coordinator IPC', async () => {
    const activation = createCliExpansionActivation();
    const request = vi.fn().mockResolvedValue({
      status: 'equipped',
      expansion: {
        name: 'needle',
        status: 'equipped',
      },
    });
    mockState.ensure.mockResolvedValue({ request });

    await expect(activation.activateExpansion('needle')).resolves.toEqual({
      status: 'equipped',
      expansion: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'equipped',
      },
    });
    expect(request).toHaveBeenCalledWith('coordinator.equipExpansion', { name: 'needle' });
  });

  it('surfaces activation failures instead of collapsing them to unavailable', async () => {
    const activation = createCliExpansionActivation();
    const error = Object.assign(new Error('coordinator.equipExpansion failed'), { code: 'boom' });
    const request = vi.fn().mockRejectedValue(error);
    mockState.ensure.mockResolvedValue({ request });

    await expect(activation.activateExpansion('needle')).rejects.toBe(error);
    expect(request).toHaveBeenCalledWith('coordinator.equipExpansion', { name: 'needle' });
  });

  it('deactivates expansions through ensure-backed coordinator IPC', async () => {
    const activation = createCliExpansionActivation();
    const request = vi.fn().mockResolvedValue({ status: 'uninstalled' });
    mockState.ensure.mockResolvedValue({ request });

    await expect(activation.deactivateExpansion('needle')).resolves.toEqual({ status: 'uninstalled' });
    expect(request).toHaveBeenCalledWith('coordinator.unequipExpansion', { name: 'needle' });
  });

  it('returns unavailable when passive discovery cannot be read', async () => {
    const activation = createCliExpansionActivation();
    process.env.CORAL_FLAVOR = 'dev';
    mockState.readDiscoveryRecord.mockReturnValue(null);

    await expect(activation.readExpansionStatus('needle')).resolves.toEqual({ status: 'unavailable' });
    expect(mockState.readDiscoveryRecord).toHaveBeenCalled();
    expect(mockState.createIpcClient).not.toHaveBeenCalled();
  });

  it('uses the settled build flavor for passive discovery when CORAL_FLAVOR is unset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-activate-settled-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    delete process.env.CORAL_FLAVOR;

    mockState.createIpcClient.mockReset();
    mockState.readDiscoveryRecord.mockReset();
    vi.resetModules();
    vi.doUnmock('#src/infra/coordinator-discovery.js');

    try {
      const [{ writeDiscoveryRecord }, { createCliExpansionActivation: createFreshActivation }, { createRealRuntime }] =
        await Promise.all([
          import('#src/infra/coordinator-discovery.js'),
          import('#src/cli/expansion-activation.js'),
          import('#src/runtime/real.js'),
        ]);
      const request = vi.fn().mockResolvedValue({ expansions: [] });

      process.env.CORAL_FLAVOR = 'dev';
      const runtime = createRealRuntime('dev');
      writeDiscoveryRecord(
        makeDiscoveryRecord({
          flavor: 'dev',
          socketPath: '/tmp/coral-dev.sock',
        }),
        { storage: runtime.storage, env: runtime.env, paths: runtime.paths },
      );
      mockState.createIpcClient.mockReturnValue({ request });

      await expect(createFreshActivation().readExpansionStatus()).resolves.toEqual({
        status: 'available',
        expansions: [],
      });
      expect(mockState.createIpcClient).toHaveBeenCalledWith('/tmp/coral-dev.sock');
      expect(request).toHaveBeenCalledWith('coordinator.listExpansion', {});
    } finally {
      rmSync(home, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('returns unavailable when passive IPC dial fails after discovery succeeds', async () => {
    const activation = createCliExpansionActivation();
    const request = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('connect failed'), { code: 'ipc_connect_failed' }));
    mockState.readDiscoveryRecord.mockReturnValue(makeDiscoveryRecord({ socketPath: '/tmp/coral-passive.sock' }));
    mockState.createIpcClient.mockReturnValue({ request });

    await expect(activation.readExpansionStatus()).resolves.toEqual({ status: 'unavailable' });
    expect(mockState.createIpcClient).toHaveBeenCalledWith('/tmp/coral-passive.sock');
    expect(request).toHaveBeenCalledWith('coordinator.listExpansion', {});
  });
});
