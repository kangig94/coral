import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { DiscoveryRuntime } from '#src/infra/backend-discovery.js';

const mockState = vi.hoisted(() => ({
  home: '',
  platform: process.platform,
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.home,
    platform: () => mockState.platform,
  };
});

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function importDiscovery() {
  vi.resetModules();
  return import('#src/infra/backend-discovery.js');
}

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-discovery-home-'));
  tempRoots.push(root);
  mockState.home = root;
  return root;
}

function makeDiscoveryRuntime(flavor: 'prod' | 'dev'): DiscoveryRuntime {
  const runtime = createRealRuntime(flavor);
  return { storage: runtime.storage, env: runtime.env, paths: runtime.paths };
}

describe('coordinator discovery', () => {
  it('round-trips a discovery record through read/write', async () => {
    makeHome();
    const { readDiscoveryRecord, writeDiscoveryRecord } = await importDiscovery();
    const runtime = makeDiscoveryRuntime('prod');

    writeDiscoveryRecord(
      {
        pid: process.pid,
        port: 4312,
        socketPath: coordinatorPaths('prod').socketPath,
        host: '127.0.0.1',
        bundleHash: 'bundle-a',
        flavor: 'prod',
        namespace: 'ns-a',
        startedAt: 1_713_456_789_000,
        token: 'token-a',
        bootToken: 'boot-token-a',
        shutdownToken: 'shutdown-token-a',
        version: '1.2.3',
        instanceId: 'instance-a',
      },
      runtime,
    );

    expect(readDiscoveryRecord(runtime)).toMatchObject({
      pid: process.pid,
      port: 4312,
      host: '127.0.0.1',
      bundleHash: 'bundle-a',
      flavor: 'prod',
      namespace: 'ns-a',
      startedAt: 1_713_456_789_000,
      token: 'token-a',
      bootToken: 'boot-token-a',
      shutdownToken: 'shutdown-token-a',
      version: '1.2.3',
      instanceId: 'instance-a',
    });
  });

  it('probeCoordinator returns the record when pid and process start time match', async () => {
    makeHome();
    const { probeCoordinator, writeDiscoveryRecord } = await importDiscovery();
    const { probeProcessStartedAtSeconds } = await import('#src/infra/node-process.js');
    const runtime = makeDiscoveryRuntime('dev');

    writeDiscoveryRecord(
      {
        pid: process.pid,
        port: 9021,
        socketPath: coordinatorPaths('dev').socketPath,
        bundleHash: 'bundle-b',
        flavor: 'dev',
        namespace: 'ns-b',
        startedAt: Date.now(),
        token: 'token-b',
        bootToken: 'boot-token-b',
        processStartedAt: probeProcessStartedAtSeconds(process.pid) ?? undefined,
      },
      runtime,
    );

    expect(probeCoordinator(runtime)).toMatchObject({
      pid: process.pid,
      port: 9021,
      bundleHash: 'bundle-b',
      flavor: 'dev',
      namespace: 'ns-b',
      token: 'token-b',
      bootToken: 'boot-token-b',
    });
  });

  it('probeCoordinator rejects a record when processStartedAt does not match the live process', async () => {
    makeHome();
    const { probeCoordinator, writeDiscoveryRecord } = await importDiscovery();
    const { probeProcessStartedAtSeconds } = await import('#src/infra/node-process.js');
    const runtime = makeDiscoveryRuntime('prod');

    writeDiscoveryRecord(
      {
        pid: process.pid,
        port: 9022,
        socketPath: coordinatorPaths('prod').socketPath,
        bundleHash: 'bundle-c',
        flavor: 'prod',
        namespace: 'ns-c',
        startedAt: Date.now(),
        token: 'token-c',
        bootToken: 'boot-token-c',
        processStartedAt: (probeProcessStartedAtSeconds(process.pid) ?? 0) + 1,
      },
      runtime,
    );

    expect(probeCoordinator(runtime)).toBeNull();
  });

  it('reads a discovery record that carries a field this build predates', async () => {
    makeHome();
    const { readDiscoveryRecord, writeDiscoveryRecord } = await importDiscovery();
    const runtime = makeDiscoveryRuntime('prod');

    writeDiscoveryRecord(
      {
        pid: process.pid,
        port: 4313,
        socketPath: coordinatorPaths('prod').socketPath,
        bundleHash: 'bundle-d',
        flavor: 'prod',
        namespace: 'ns-d',
        startedAt: Date.now(),
        token: 'token-d',
        bootToken: 'boot-token-d',
      },
      runtime,
    );

    // A build newer than this one adds a field to the record before either build's schema knows about
    // it — simulated here by writing it straight to disk, past `writeDiscoveryRecord`'s own field set.
    const infoPath = runtime.paths.coral.coordinator.infoFile;
    const written = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
    writeFileSync(infoPath, JSON.stringify({ ...written, futureField: 'added-by-a-newer-coordinator' }), 'utf-8');

    expect(readDiscoveryRecord(runtime)).toMatchObject({ namespace: 'ns-d', token: 'token-d' });
  });
});
