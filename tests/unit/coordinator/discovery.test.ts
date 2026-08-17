import { testIncarnation } from '#tests/helpers/process-incarnation.js';
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

  it('probeCoordinator reports a live record for a pid that names a running process', async () => {
    makeHome();
    const { probeCoordinator, writeDiscoveryRecord } = await importDiscovery();
    const { probeProcessIncarnation } = await import('#src/infra/node-process.js');
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
        incarnation: probeProcessIncarnation(process.pid) ?? undefined,
      },
      runtime,
    );

    expect(probeCoordinator(runtime)).toMatchObject({
      kind: 'live',
      record: {
        pid: process.pid,
        port: 9021,
        bundleHash: 'bundle-b',
        flavor: 'dev',
        namespace: 'ns-b',
        token: 'token-b',
        bootToken: 'boot-token-b',
      },
    });
  });

  // A record whose `incarnation` disagrees with a fresh probe of the same live pid must still be
  // returned. The value is `/proc/stat` btime plus start ticks, and btime is cached per process, so the
  // writer's value and this reader's disagree by roughly the age gap between their first probes — 168
  // seconds, measured on a WSL2 host, for a coordinator probing its own pid. Rejecting on that basis
  // discarded the `bootToken` beside it, leaving a newer build unable to ask the incumbent to stand
  // down; it died on every session start while the older daemon served on.
  it('probeCoordinator returns a live record whose recorded incarnation disagrees with a fresh probe', async () => {
    makeHome();
    const { probeCoordinator, writeDiscoveryRecord } = await importDiscovery();
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
        incarnation: testIncarnation('a-different-boot'),
      },
      runtime,
    );

    expect(
      probeCoordinator(runtime),
      'the credential beside a live pid must survive a clock base this reader does not share',
    ).toMatchObject({ kind: 'live', record: { pid: process.pid, bootToken: 'boot-token-c' } });
  });

  // The upgrade that introduces the token. A coordinator from a build that predates it writes no
  // incarnation at all, and its record must still yield the `bootToken` beside it — refusing it here
  // would reinstate, for exactly that upgrade, the deadlock the token exists to end.
  it('reads a record written before the incarnation existed', async () => {
    makeHome();
    const { probeCoordinator } = await importDiscovery();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const runtime = makeDiscoveryRuntime('prod');
    const paths = coordinatorPaths('prod');

    // Written by hand rather than through `writeDiscoveryRecord`, which stamps the token every new
    // writer produces. The point is the record a build that never had one left behind.
    mkdirSync(dirname(paths.infoFile), { recursive: true });
    writeFileSync(
      paths.infoFile,
      JSON.stringify({
        pid: process.pid,
        port: 9024,
        socketPath: paths.socketPath,
        bundleHash: 'bundle-legacy',
        flavor: 'prod',
        namespace: 'ns-legacy',
        startedAt: Date.now(),
        token: 'token-legacy',
        bootToken: 'boot-token-legacy',
        processStartedAt: 1_786_795_964,
      }),
      'utf-8',
    );

    const probed = probeCoordinator(runtime);
    expect(probed, 'a pre-token record must still carry its credential').toMatchObject({
      kind: 'live',
      record: { pid: process.pid, bootToken: 'boot-token-legacy' },
    });
    if (probed.kind !== 'live') throw new Error(`expected a live probe, got ${probed.kind}`);
    expect(probed.record.incarnation, 'and it simply has no token').toBeUndefined();
  });

  it('probeCoordinator reports absence for a record whose pid names no process', async () => {
    makeHome();
    const { probeCoordinator, writeDiscoveryRecord } = await importDiscovery();
    const runtime = makeDiscoveryRuntime('prod');

    writeDiscoveryRecord(
      {
        pid: 2147483646,
        port: 9023,
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

    expect(probeCoordinator(runtime), 'liveness is an observation this reader can make alone').toEqual({
      kind: 'absent',
    });
  });

  // The third answer, and the reason this reader returns three. A pid it cannot observe is not a pid it has
  // shown to be gone, and the record beside it carries the `bootToken` a contender needs to ask an incumbent
  // to stand down. Collapsing this into `absent` is what let a transient probe failure route a contender past
  // a coordinator that was still serving.
  it('probeCoordinator reports unobservable, keeping the credential, when the pid cannot be observed', async () => {
    makeHome();
    const { probeCoordinator, writeDiscoveryRecord } = await importDiscovery();
    const runtime = makeDiscoveryRuntime('prod');

    writeDiscoveryRecord(
      {
        pid: process.pid,
        port: 9024,
        socketPath: coordinatorPaths('prod').socketPath,
        bundleHash: 'bundle-e',
        flavor: 'prod',
        namespace: 'ns-e',
        startedAt: Date.now(),
        token: 'token-e',
        bootToken: 'boot-token-e',
      },
      runtime,
    );

    // Neither ESRCH nor EPERM, which is what `observeProcessLiveness` answers `unknown` to.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('probe refused'), { code: 'EIO' });
    });

    expect(probeCoordinator(runtime), 'an unanswered probe is not proof of absence').toMatchObject({
      kind: 'unobservable',
      record: { pid: process.pid, bootToken: 'boot-token-e' },
    });
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
