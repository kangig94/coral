import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';

import { createRealRuntime } from '#src/runtime/real.js';
import { writeBackendInfo, type BackendInfo } from '#src/infra/backend-discovery.js';
import { pluginRootNamespace } from "#src/infra/plugin-identity.js";
import { resolveBackendDefaults } from '#src/coordinator/composition/defaults.js';
import type { LockRecord } from '#src/coordinator/lock.js';

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

type HarnessOptions = {
  infoOverrides?: Partial<BackendInfo>;
  recordOverrides?: Partial<LockRecord>;
  skipPrime?: boolean;
};

function makeHealthResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createHarness(options: HarnessOptions = {}) {
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
  const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response());
  const defaultsPlan = resolveBackendDefaults(
    {
      runtime,
      fetchFn,
      runStartupRecoveryFn: async () => [],
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
    version: '9.9.9',
    bundleHash: 'backend-defaults-bundle',
    flavor: 'prod',
    namespace: expectedNamespace,
    instanceId: 'backend-defaults-instance',
    startedAt: 1,
    ...options.infoOverrides,
  };
  const record: LockRecord = {
    instanceId: info.instanceId,
    pid: info.pid,
    version: info.version,
    bundleHash: info.bundleHash,
    flavor: info.flavor,
    startedAt: info.startedAt,
    ...options.recordOverrides,
  };

  if (!options.skipPrime) {
    writeBackendInfo(pluginRoot, info, runtime);
  }

  return {
    pluginRoot,
    runtime,
    fetchFn,
    info,
    record,
    expectedNamespace,
    verifyBackendOwnershipFn: defaultsPlan.eager.verifyBackendOwnershipFn,
  };
}

describe('resolveBackendDefaults verifyBackendOwnershipFn', () => {
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

  it('1. healthy returns healthy for matching /health metadata via injected fetchFn', async () => {
    const harness = createHarness();
    harness.fetchFn.mockResolvedValue(
      makeHealthResponse({
        status: 'ok',
        bundleHash: harness.record.bundleHash,
        flavor: harness.record.flavor,
        instanceId: harness.record.instanceId,
        namespace: harness.expectedNamespace,
      }),
    );

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('healthy');
    expect(harness.fetchFn).toHaveBeenCalledWith(`http://${harness.info.host}:${harness.info.port}/health`, {
      method: 'GET',
      headers: { 'X-Coral-Backend-Token': harness.info.token },
      signal: expect.any(AbortSignal),
    });
  });

  it('2. contended-payload-mismatch returns contended when /health bundleHash mismatches', async () => {
    const harness = createHarness();
    harness.fetchFn.mockResolvedValue(
      makeHealthResponse({
        status: 'ok',
        bundleHash: 'different-bundle',
        flavor: harness.record.flavor,
        instanceId: harness.record.instanceId,
        namespace: harness.expectedNamespace,
      }),
    );

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('contended');
  });

  it('3. contended-non-ok returns contended when /health is not ok', async () => {
    const harness = createHarness();
    harness.fetchFn.mockResolvedValue(makeHealthResponse({ status: 'unavailable' }, 503));

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('contended');
  });

  it('4. stale-no-info returns stale and never calls fetchFn when backend info is absent', async () => {
    const harness = createHarness({ skipPrime: true });

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('stale');
    expect(harness.fetchFn).not.toHaveBeenCalled();
  });

  it('5. stale-record-mismatch returns stale and never calls fetchFn when discovery metadata disagrees with the lock record', async () => {
    const harness = createHarness({
      infoOverrides: {
        namespace: 'foreign-namespace',
      },
    });

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('stale');
    expect(harness.fetchFn).not.toHaveBeenCalled();
  });

  it('6. stale-pid-dead returns stale and never calls fetchFn when the recorded pid is no longer alive', async () => {
    const harness = createHarness({
      infoOverrides: {
        pid: 999_999,
      },
    });

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('stale');
    expect(harness.fetchFn).not.toHaveBeenCalled();
  });

  it('7. stale-bundle-mismatch returns stale when info bundleHash differs from the lock record', async () => {
    const harness = createHarness({
      recordOverrides: {
        bundleHash: 'different-bundle-hash',
      },
    });

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('stale');
    expect(harness.fetchFn).not.toHaveBeenCalled();
  });

  it('8. contended-non-object-body returns contended when /health response body is not an object', async () => {
    const harness = createHarness();
    harness.fetchFn.mockResolvedValue(makeHealthResponse(null as unknown as Record<string, unknown>));

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('contended');
    expect(harness.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('9. contended-fetch-throws returns contended when fetchFn rejects (timeout / abort / network)', async () => {
    const harness = createHarness();
    harness.fetchFn.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    await expect(
      harness.verifyBackendOwnershipFn({
        pluginRoot: harness.pluginRoot,
        record: harness.record,
      }),
    ).resolves.toBe('contended');
    expect(harness.fetchFn).toHaveBeenCalledTimes(1);
  });
});
