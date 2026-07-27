import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BackendDiscoveryModule from '#src/infra/backend-discovery.js';
import type * as IpcClientModule from '#src/transport/ipc/client.js';
import type { CoordinatorDiscoveryRecord } from '#src/infra/backend-discovery.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
  readDiscoveryRecord: vi.fn<(runtime: unknown) => CoordinatorDiscoveryRecord | null>(),
  createIpcClient: vi.fn(),
}));

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

vi.mock('#src/infra/backend-discovery.js', async () => {
  const actual = await vi.importActual<typeof BackendDiscoveryModule>('#src/infra/backend-discovery.js');
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

import { createCliExpansionActivation } from '#src/cli/expansion/index.js';

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
    bootToken: 'boot-token-a',
    ...overrides,
  };
}

describe('expansion activation', () => {
  const originalFlavor = process.env.CORAL_FLAVOR;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalChild = process.env.CORAL_CHILD;
  const originalChildPrincipalHandle = process.env.CORAL_CHILD_PRINCIPAL_HANDLE;
  const originalJobId = process.env.CORAL_JOB_ID;
  const originalSessionId = process.env.CORAL_SESSION_ID;
  let testHome = '';

  beforeEach(() => {
    mockState.ensure.mockReset();
    mockState.readDiscoveryRecord.mockReset();
    mockState.createIpcClient.mockReset();
    testHome = mkdtempSync(join(tmpdir(), 'coral-activate-home-'));
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
    delete process.env.CORAL_FLAVOR;
    delete process.env.CORAL_CHILD;
    delete process.env.CORAL_CHILD_PRINCIPAL_HANDLE;
    delete process.env.CORAL_JOB_ID;
    delete process.env.CORAL_SESSION_ID;
  });

  afterEach(() => {
    if (testHome) {
      rmSync(testHome, { recursive: true, force: true });
      testHome = '';
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalFlavor === undefined) {
      delete process.env.CORAL_FLAVOR;
    } else {
      process.env.CORAL_FLAVOR = originalFlavor;
    }
    if (originalChild === undefined) {
      delete process.env.CORAL_CHILD;
    } else {
      process.env.CORAL_CHILD = originalChild;
    }
    if (originalChildPrincipalHandle === undefined) {
      delete process.env.CORAL_CHILD_PRINCIPAL_HANDLE;
    } else {
      process.env.CORAL_CHILD_PRINCIPAL_HANDLE = originalChildPrincipalHandle;
    }
    if (originalJobId === undefined) {
      delete process.env.CORAL_JOB_ID;
    } else {
      process.env.CORAL_JOB_ID = originalJobId;
    }
    if (originalSessionId === undefined) {
      delete process.env.CORAL_SESSION_ID;
    } else {
      process.env.CORAL_SESSION_ID = originalSessionId;
    }
  });

  it('activates expansions through ensure-backed coordinator IPC', async () => {
    const activation = createCliExpansionActivation();
    const request = vi.fn().mockResolvedValue({
      status: 'equipped',
      expansion: {
        name: 'onnx',
        tier: 'installed',
        status: 'equipped',
      },
    });
    mockState.ensure.mockResolvedValue({ request });

    await expect(activation.activateExpansion('onnx')).resolves.toEqual({
      status: 'equipped',
      expansion: {
        slot: 'kb.embedding',
        name: 'onnx',
        tier: 'installed',
        status: 'equipped',
      },
    });
    expect(request).toHaveBeenCalledWith('coordinator.equipExpansion', { name: 'onnx' }, undefined);
  });

  it('surfaces activation failures instead of collapsing them to unavailable', async () => {
    const activation = createCliExpansionActivation();
    const error = Object.assign(new Error('coordinator.equipExpansion failed'), { code: 'boom' });
    const request = vi.fn().mockRejectedValue(error);
    mockState.ensure.mockResolvedValue({ request });

    await expect(activation.activateExpansion('vector')).rejects.toBe(error);
    expect(request).toHaveBeenCalledWith('coordinator.equipExpansion', { name: 'vector' }, undefined);
  });

  it('runs env-var onboarding before gemini activation', async () => {
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const activation = createCliExpansionActivation();

    try {
      await expect(activation.equip('gemini')).resolves.toMatchObject({
        status: 'error',
        code: 'engine_env_var_missing',
        userMessage: "Engine 'gemini' needs environment variable 'GEMINI_API_KEY'.",
        remediation:
          "Set GEMINI_API_KEY in the backend's environment (e.g. the `env` block of ~/.claude/settings.json), run 'coral-cli backend shutdown' so the next command relaunches with it, then rerun `coral-cli expansion equip gemini`.",
        context: { engine: 'gemini', envVar: 'GEMINI_API_KEY' },
      });
      expect(mockState.ensure).not.toHaveBeenCalled();
    } finally {
      if (originalGeminiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = originalGeminiKey;
      }
    }
  });

  it('deactivates expansions through ensure-backed coordinator IPC', async () => {
    const activation = createCliExpansionActivation();
    const request = vi.fn().mockResolvedValue({ status: 'uninstalled' });
    mockState.ensure.mockResolvedValue({ request });

    await expect(activation.deactivateExpansion('vector')).resolves.toEqual({ status: 'uninstalled' });
    expect(request).toHaveBeenCalledWith('coordinator.unequipExpansion', { name: 'vector' }, undefined);
  });

  it('removes expansion catalog entries through coordinator IPC without deactivating first', async () => {
    const activation = createCliExpansionActivation();
    const request = vi.fn().mockResolvedValue({ status: 'removed' });
    mockState.ensure.mockResolvedValue({ request });

    await expect(activation.removeCatalog('external-cache')).resolves.toEqual({ status: 'uninstalled' });
    expect(request).toHaveBeenCalledWith('coordinator.removeExpansionCatalog', { name: 'external-cache' }, undefined);
    expect(request).not.toHaveBeenCalledWith('coordinator.unequipExpansion', { name: 'external-cache' }, undefined);
  });

  it('merges catalog-absent daemon state into the operator-visible retired residue list', async () => {
    const activation = createCliExpansionActivation();
    mockState.readDiscoveryRecord.mockReturnValue(makeDiscoveryRecord());
    mockState.createIpcClient.mockReturnValue({
      request: vi.fn().mockResolvedValue({
        expansions: [
          {
            name: 'retired-vector',
            version: '0.9.0',
            tier: 'installed',
            status: 'installed-not-active',
            lastError:
              "Expansion 'retired-vector' is no longer in the catalog. Run 'coral-cli expansion remove-catalog retired-vector' to remove retired expansion artifacts.",
          },
        ],
      }),
    });

    const result = await activation.list();
    expect(result.status).toBe('catalog');
    if (result.status !== 'catalog') {
      throw new Error('expected catalog result');
    }
    expect(result.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'retired-vector',
          name: 'retired-vector',
          tier: 'installed',
          activation: 'remove-catalog',
          status: 'installed-not-active',
          version: '0.9.0',
          cleanupCommand: 'coral-cli expansion remove-catalog retired-vector',
          lastError: expect.stringContaining('coral-cli expansion remove-catalog retired-vector'),
        }),
      ]),
    );

    await expect(activation.info('retired-vector')).resolves.toMatchObject({
      status: 'info',
      package: {
        id: 'retired-vector',
        activation: 'remove-catalog',
        cleanupCommand: 'coral-cli expansion remove-catalog retired-vector',
      },
    });
  });

  it.each(['bad; touch /tmp/injected', 'corpus-projection'])(
    'does not expose an executable cleanup command for unsafe or reserved residue %s',
    async (name) => {
      const activation = createCliExpansionActivation();
      mockState.readDiscoveryRecord.mockReturnValue(makeDiscoveryRecord());
      mockState.createIpcClient.mockReturnValue({
        request: vi.fn().mockResolvedValue({
          expansions: [
            {
              name,
              version: '0.9.0',
              tier: 'installed',
              status: 'installed-not-active',
              lastError: `Run 'coral-cli expansion remove-catalog ${name}' to remove retired expansion artifacts.`,
            },
          ],
        }),
      });

      const result = await activation.list();
      expect(result.status).toBe('catalog');
      if (result.status !== 'catalog') {
        throw new Error('expected catalog result');
      }
      const residue = result.packages.find((entry) => entry.id === name);
      expect(residue).toMatchObject({
        id: name,
        activation: 'remove-catalog',
        lastError: expect.stringContaining('cannot provide an executable cleanup command'),
      });
      expect(residue).not.toHaveProperty('cleanupCommand');
      expect(residue?.activation).toBe('remove-catalog');
      if (residue?.activation !== 'remove-catalog') {
        throw new Error('expected retired residue');
      }
      expect(residue.lastError).not.toContain(name);
    },
  );

  it('maps immutable catalog removal without exposing the internal status string', async () => {
    const activation = createCliExpansionActivation();
    const request = vi.fn().mockResolvedValue({ status: 'immutable' });
    mockState.ensure.mockResolvedValue({ request });

    await expect(activation.removeCatalog('orama')).resolves.toMatchObject({
      status: 'error',
      code: 'expansion_bundled_immutable',
    });
  });

  it('returns unavailable when passive discovery cannot be read', async () => {
    const activation = createCliExpansionActivation();
    process.env.CORAL_FLAVOR = 'dev';
    mockState.readDiscoveryRecord.mockReturnValue(null);

    await expect(activation.readExpansionStatus('vector')).resolves.toEqual({ status: 'unavailable' });
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
    vi.doUnmock('#src/infra/backend-discovery.js');

    try {
      const [{ writeDiscoveryRecord }, { createCliExpansionActivation: createFreshActivation }, { createRealRuntime }] =
        await Promise.all([
          import('#src/infra/backend-discovery.js'),
          import('#src/cli/expansion/index.js'),
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
      expect(mockState.createIpcClient).toHaveBeenCalledWith('/tmp/coral-dev.sock', expect.any(Object), {
        kind: 'boot',
        token: 'boot-token-a',
      });
      expect(request).toHaveBeenCalledWith('coordinator.listExpansion', {}, undefined);
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
    expect(mockState.createIpcClient).toHaveBeenCalledWith('/tmp/coral-passive.sock', expect.any(Object), {
      kind: 'boot',
      token: 'boot-token-a',
    });
    expect(request).toHaveBeenCalledWith('coordinator.listExpansion', {}, undefined);
  });
});
