import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CoordinatorDiscoveryRecord } from '../../coordinator/discovery-api.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  readPassiveDiscovery: vi.fn<(flavor: 'prod' | 'dev') => CoordinatorDiscoveryRecord | null>(),
  createIpcClient: vi.fn(),
}));

vi.mock('../../transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

vi.mock('../../coordinator/discovery-api.js', async () => {
  const actual = await vi.importActual<typeof import('../../coordinator/discovery-api.js')>(
    '../../coordinator/discovery-api.js',
  );
  return {
    ...actual,
    readPassiveDiscovery: mockState.readPassiveDiscovery,
  };
});

vi.mock('../../transport/ipc/client.js', async () => {
  const actual = await vi.importActual<typeof import('../../transport/ipc/client.js')>(
    '../../transport/ipc/client.js',
  );
  return {
    ...actual,
    createIpcClient: mockState.createIpcClient,
  };
});

import { activateExpansion, deactivateExpansion, readEquipmentStatus } from '../activate.js';

function makeDiscoveryRecord(
  overrides: Partial<CoordinatorDiscoveryRecord> = {},
): CoordinatorDiscoveryRecord {
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

describe('expansion activation (AC6)', () => {
  const originalFlavor = process.env.CORAL_FLAVOR;

  beforeEach(() => {
    mockState.ensure.mockReset();
    mockState.readPassiveDiscovery.mockReset();
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

  it('activates equipment through ensure-backed coordinator IPC', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'equipped',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'equipped',
      },
    });
    mockState.ensure.mockResolvedValue({ request });

    await expect(activateExpansion('needle')).resolves.toEqual({
      status: 'equipped',
      equipment: {
        slot: 'kb.vector',
        name: 'needle',
        status: 'equipped',
      },
    });
    expect(request).toHaveBeenCalledWith('coordinator.registerEquipment', { name: 'needle' });
  });

  it('surfaces activation failures instead of collapsing them to unavailable', async () => {
    const error = Object.assign(new Error('coordinator.registerEquipment failed'), { code: 'boom' });
    const request = vi.fn().mockRejectedValue(error);
    mockState.ensure.mockResolvedValue({ request });

    await expect(activateExpansion('needle')).rejects.toBe(error);
    expect(request).toHaveBeenCalledWith('coordinator.registerEquipment', { name: 'needle' });
  });

  it('deactivates equipment through ensure-backed coordinator IPC', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'uninstalled' });
    mockState.ensure.mockResolvedValue({ request });

    await expect(deactivateExpansion('needle')).resolves.toEqual({ status: 'uninstalled' });
    expect(request).toHaveBeenCalledWith('coordinator.unregisterEquipment', { name: 'needle' });
  });

  it('returns unavailable when passive discovery cannot be read', async () => {
    process.env.CORAL_FLAVOR = 'dev';
    mockState.readPassiveDiscovery.mockReturnValue(null);

    await expect(readEquipmentStatus('needle')).resolves.toEqual({ status: 'unavailable' });
    expect(mockState.readPassiveDiscovery).toHaveBeenCalledWith('dev');
    expect(mockState.createIpcClient).not.toHaveBeenCalled();
  });

  it('uses the settled build flavor for passive discovery when CORAL_FLAVOR is unset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-activate-settled-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    delete process.env.CORAL_FLAVOR;

    mockState.createIpcClient.mockReset();
    mockState.readPassiveDiscovery.mockReset();
    vi.resetModules();
    vi.doUnmock('../../coordinator/discovery-api.js');

    try {
      const [{ setBuildFlavor }, { writeDiscoveryRecord }, { readEquipmentStatus: readEquipmentStatusFresh }] = await Promise.all([
        import('../../infra/paths.js'),
        import('../../coordinator/discovery.js'),
        import('../activate.js'),
      ]);
      const request = vi.fn().mockResolvedValue({ equipment: [] });

      setBuildFlavor('dev');
      writeDiscoveryRecord(
        'dev',
        makeDiscoveryRecord({
          flavor: 'dev',
          socketPath: '/tmp/coral-dev.sock',
        }),
      );
      mockState.createIpcClient.mockReturnValue({ request });

      await expect(readEquipmentStatusFresh()).resolves.toEqual({
        status: 'available',
        equipment: [],
      });
      expect(mockState.createIpcClient).toHaveBeenCalledWith('/tmp/coral-dev.sock');
      expect(request).toHaveBeenCalledWith('coordinator.listEquipment', {});
    } finally {
      rmSync(home, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('returns unavailable when passive IPC dial fails after discovery succeeds', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('connect failed'), { code: 'ipc_connect_failed' }));
    mockState.readPassiveDiscovery.mockReturnValue(makeDiscoveryRecord({ socketPath: '/tmp/coral-passive.sock' }));
    mockState.createIpcClient.mockReturnValue({ request });

    await expect(readEquipmentStatus()).resolves.toEqual({ status: 'unavailable' });
    expect(mockState.createIpcClient).toHaveBeenCalledWith('/tmp/coral-passive.sock');
    expect(request).toHaveBeenCalledWith('coordinator.listEquipment', {});
  });
});
