import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';

import { createRealRuntime } from '#src/runtime/real.js';
import { readBackendInfo, type BackendInfo } from '#src/infra/backend-discovery.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import {
  HTTP_SERVER_HEADERS_TIMEOUT_MS,
  HTTP_SERVER_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_SERVER_REQUEST_TIMEOUT_MS,
  resolveCoordinatorDefaults,
} from '#src/coordinator/composition/defaults.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: '',
  baseTmp: `${process.env.TMPDIR ?? '/tmp'}/coral-backend-defaults-${process.pid}-${Date.now()}`,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
    tmpdir: () => mockState.tmpRoot,
  };
});

function createHarness() {
  const home = mkdtempSync(join(mockState.tmpRoot, 'home-'));
  const pluginRoot = mkdtempSync(join(mockState.tmpRoot, 'plugin-'));
  mockState.tmpHome = home;
  vi.stubEnv('HOME', home);

  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: 'backend-defaults-bundle', flavor: 'prod' }) + '\n',
    'utf-8',
  );

  const runtime = createRealRuntime('prod');
  const defaultsPlan = resolveCoordinatorDefaults(
    {
      runtime,
      storeFormat: currentCoralStoreFormat(),
      runStartupRecoveryFn: async () => [],
      getConsumerStuck: () => [],
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
    },
    runtime,
  );
  const expectedNamespace = pluginRootNamespace(pluginRoot);
  const info: BackendInfo = {
    pid: process.pid,
    port: 4312,
    socketPath: '/tmp/coral-backend-defaults.sock',
    host: '127.0.0.1',
    token: 'backend-defaults-token',
    bootToken: 'backend-defaults-boot-token',
    version: '9.9.9',
    bundleHash: 'backend-defaults-bundle',
    flavor: 'prod',
    namespace: expectedNamespace,
    instanceId: 'backend-defaults-instance',
    startedAt: 1,
  };

  return {
    pluginRoot,
    runtime,
    info,
    defaults: defaultsPlan.eager,
  };
}

describe('resolveCoordinatorDefaults eager defaults', () => {
  beforeEach(() => {
    mkdirSync(mockState.baseTmp, { recursive: true });
    mockState.tmpRoot = mkdtempSync(join(mockState.baseTmp, 'run-'));
    mockState.tmpHome = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (mockState.tmpRoot) {
      rmSync(mockState.tmpRoot, { recursive: true, force: true });
    }
    mockState.tmpHome = '';
    mockState.tmpRoot = '';
  });

  it('does not expose lock-related defaults', () => {
    const { defaults } = createHarness();
    const surface = defaults as Record<string, unknown>;
    expect(surface.acquireLockFn).toBeUndefined();
    expect(surface.removeLockIfOwnerFn).toBeUndefined();
    expect(surface.verifyBackendOwnershipFn).toBeUndefined();
  });

  it('sets explicit HTTP server timeout defaults', () => {
    const { defaults } = createHarness();
    const server = defaults.createServerFn(() => {});

    expect(server.requestTimeout).toBe(HTTP_SERVER_REQUEST_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HTTP_SERVER_HEADERS_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBe(HTTP_SERVER_KEEP_ALIVE_TIMEOUT_MS);
  });

  it('writeBackendInfoFn persists discovery and removeBackendInfoIfOwnerFn clears it for the owner', () => {
    const harness = createHarness();
    const discoveryRuntime = {
      storage: harness.runtime.storage,
      env: harness.runtime.env,
      paths: harness.runtime.paths,
    };

    harness.defaults.writeBackendInfoFn(harness.info);
    expect(readBackendInfo(discoveryRuntime)).toMatchObject({
      instanceId: harness.info.instanceId,
      bundleHash: harness.info.bundleHash,
      flavor: harness.info.flavor,
    });

    harness.defaults.removeBackendInfoIfOwnerFn(harness.info.instanceId);
    expect(readBackendInfo(discoveryRuntime)).toBeNull();
  });

  it('removeBackendInfoIfOwnerFn does not clear discovery owned by a different instanceId', () => {
    const harness = createHarness();
    const discoveryRuntime = {
      storage: harness.runtime.storage,
      env: harness.runtime.env,
      paths: harness.runtime.paths,
    };

    harness.defaults.writeBackendInfoFn(harness.info);
    harness.defaults.removeBackendInfoIfOwnerFn('some-other-instance');
    expect(readBackendInfo(discoveryRuntime)).not.toBeNull();
  });
});
