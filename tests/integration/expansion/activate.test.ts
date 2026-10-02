import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as BackendDiscoveryModule from '#src/infra/backend-discovery.js';
import type * as NodeProcessModule from '#src/infra/node-process.js';
import type * as IpcClientModule from '#src/transport/ipc/client.js';
import type { CoordinatorDiscoveryRecord, DiscoveryRead } from '#src/infra/backend-discovery.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

const mockState = vi.hoisted(() => ({
  readDiscoveryRecordDisposition: vi.fn<(runtime: unknown) => DiscoveryRead>(),
  createIpcClient: vi.fn(),
  // Only consulted once a decoded record's socket dial fails — see the `ipc_connect_failed` tests below.
  // Defaults `alive` so any test that never sets it exercises the common case rather than an unset mock.
  processLiveness: 'alive' as 'alive' | 'absent' | 'unknown',
}));

vi.mock('#src/infra/backend-discovery.js', async () => {
  const actual = await vi.importActual<typeof BackendDiscoveryModule>('#src/infra/backend-discovery.js');
  return {
    ...actual,
    readDiscoveryRecordDisposition: mockState.readDiscoveryRecordDisposition,
  };
});

vi.mock('#src/infra/node-process.js', async () => {
  const actual = await vi.importActual<typeof NodeProcessModule>('#src/infra/node-process.js');
  return {
    ...actual,
    observeProcessLiveness: vi.fn(() => mockState.processLiveness),
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

function createCurrentStore(runtime: ReturnType<typeof createRealRuntime>): void {
  openTestStoreDatabase({
    path: join(runtime.paths.coral.store.dbDir, 'store.db'),
    storage: runtime.storage,
    storeFormat: currentCoralStoreFormat(),
  }).close();
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
    mockState.readDiscoveryRecordDisposition.mockReset();
    mockState.createIpcClient.mockReset();
    mockState.processLiveness = 'alive';
    testHome = mkdtempSync(join(tmpdir(), 'coral-activate-home-'));
    process.env.HOME = testHome;
    process.env.USERPROFILE = testHome;
    delete process.env.CORAL_FLAVOR;
    delete process.env.CORAL_CHILD;
    delete process.env.CORAL_CHILD_PRINCIPAL_HANDLE;
    delete process.env.CORAL_JOB_ID;
    delete process.env.CORAL_SESSION_ID;
    createCurrentStore(createRealRuntime('prod'));
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

  it.each(['bad; touch /tmp/injected', 'corpus-projection'])(
    'does not expose an executable cleanup command for unsafe or reserved residue %s',
    async (name) => {
      const activation = createCliExpansionActivation();
      mockState.readDiscoveryRecordDisposition.mockReturnValue({ kind: 'record', record: makeDiscoveryRecord() });
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

  // `readDiscoveryRecordDisposition` throwing (`EACCES`, `EIO`) used to be swallowed by a blanket `catch` to
  // `null` — this path silently absorbed them instead. Every mock elsewhere in this file sets a *return*
  // value; none throws, so deleting the `try`/`catch` this test covers fails nothing else here.
  it('reports a thrown read failure (EACCES) as unreadable, not an uncaught rejection', async () => {
    const activation = createCliExpansionActivation();
    process.env.CORAL_FLAVOR = 'dev';
    mockState.readDiscoveryRecordDisposition.mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied, open '/coordinator.json'"), { code: 'EACCES' });
    });

    await expect(activation.readExpansionStatus('vector')).resolves.toEqual({
      status: 'unreadable',
      detail: "EACCES: permission denied, open '/coordinator.json'",
      path: createRealRuntime('dev').paths.coral.coordinator.infoFile,
    });
    expect(mockState.createIpcClient).not.toHaveBeenCalled();
  });

  // Was `unreadable` here — that value pinned the collapse this branch fixes, not a behaviour worth protecting:
  // it told an operator whose daemon crashed uncleanly that Coral could not read a file it had, in fact, just
  // read. With the recorded pid observed decisively absent, the coordinator that claimed this socket is
  // confirmed gone, so `unavailable` — the same real absence a missing record renders — is correct, and is
  // what this test asserted before the regression it pinned.
  it('reports unavailable, not unreadable, when the recorded pid is absent and the passive IPC dial fails', async () => {
    const activation = createCliExpansionActivation();
    const request = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('connect failed'), { code: 'ipc_connect_failed' }));
    mockState.readDiscoveryRecordDisposition.mockReturnValue({
      kind: 'record',
      record: makeDiscoveryRecord({ socketPath: '/tmp/coral-passive.sock' }),
    });
    mockState.processLiveness = 'absent';
    mockState.createIpcClient.mockReturnValue({ request });

    await expect(activation.readExpansionStatus()).resolves.toEqual({ status: 'unavailable' });
    expect(mockState.createIpcClient).toHaveBeenCalledWith('/tmp/coral-passive.sock', expect.any(Object), {
      kind: 'boot',
      token: 'boot-token-a',
    });
    expect(request).toHaveBeenCalledWith('coordinator.listExpansion', {}, undefined);
  });
});
