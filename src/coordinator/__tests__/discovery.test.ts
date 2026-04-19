import { mkdtempSync, rmSync } from 'node:fs';
import type * as NodeOs from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  return import('../discovery.js');
}

function makeHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-discovery-home-'));
  tempRoots.push(root);
  mockState.home = root;
  return root;
}

describe('coordinator discovery', () => {
  it('round-trips a discovery record through read/write', async () => {
    makeHome();
    const { readDiscoveryRecord, writeDiscoveryRecord } = await importDiscovery();

    writeDiscoveryRecord('prod', {
      pid: process.pid,
      port: 4312,
      host: '127.0.0.1',
      bundleHash: 'bundle-a',
      flavor: 'prod',
      namespace: 'ns-a',
      startedAt: 1_713_456_789_000,
      token: 'token-a',
      version: '1.2.3',
      instanceId: 'instance-a',
    });

    expect(readDiscoveryRecord('prod')).toMatchObject({
      pid: process.pid,
      port: 4312,
      host: '127.0.0.1',
      bundleHash: 'bundle-a',
      flavor: 'prod',
      namespace: 'ns-a',
      startedAt: 1_713_456_789_000,
      token: 'token-a',
      version: '1.2.3',
      instanceId: 'instance-a',
    });
  });

  it('probeCoordinator returns the record when pid and process start time match', async () => {
    makeHome();
    const { probeCoordinator, probeProcessStartedAtSeconds, writeDiscoveryRecord } = await importDiscovery();

    writeDiscoveryRecord('dev', {
      pid: process.pid,
      port: 9021,
      bundleHash: 'bundle-b',
      flavor: 'dev',
      namespace: 'ns-b',
      startedAt: Date.now(),
      token: 'token-b',
      processStartedAt: probeProcessStartedAtSeconds(process.pid) ?? undefined,
    });

    expect(probeCoordinator('dev')).toMatchObject({
      pid: process.pid,
      port: 9021,
      bundleHash: 'bundle-b',
      flavor: 'dev',
      namespace: 'ns-b',
      token: 'token-b',
    });
  });

  it('probeCoordinator rejects a record when processStartedAt does not match the live process', async () => {
    makeHome();
    const { probeCoordinator, probeProcessStartedAtSeconds, writeDiscoveryRecord } = await importDiscovery();

    writeDiscoveryRecord('prod', {
      pid: process.pid,
      port: 9022,
      bundleHash: 'bundle-c',
      flavor: 'prod',
      namespace: 'ns-c',
      startedAt: Date.now(),
      token: 'token-c',
      processStartedAt: (probeProcessStartedAtSeconds(process.pid) ?? 0) + 1,
    });

    expect(probeCoordinator('prod')).toBeNull();
  });
});
