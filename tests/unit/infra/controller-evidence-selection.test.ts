import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { selectNextCandidate } from '#src/coordinator-launch/candidate-selection.js';
import { controllerBuild } from '#src/coordinator-launch/controller-build.js';
import { SupervisorLaunchMemory } from '#src/coordinator-launch/state.js';
import { strictBundleManifestSchema } from '#src/infra/bundle-manifest.js';
import { providerHandoffCapsulePath } from '#src/infra/path/provider-proxy.js';
import { readLaunchStatus } from '#src/infra/launch-status.js';
import { compareAndSwapUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import * as discovery from '#src/provider-proxy/handoff-capsule-discovery.js';
import * as registry from '#src/infra/plugin-registry.js';
import * as transfer from '#src/coordinator/succession/provider-host-transfer.js';
import { decodeHandoffCapsule } from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { custodyLedgerDir } from '#src/store/custody-ledger.js';

vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(originalVersion?: string) {
  const root = mkdtempSync(join(tmpdir(), 'coral-readable-build-'));
  roots.push(root);
  const build = strictBundleManifestSchema.parse(JSON.parse(readFileSync('clients/build/manifest.v2.json', 'utf8')));
  const originalBuild = {
    ...build,
    buildSetId: '11111111-1111-4111-8111-111111111111',
    version: originalVersion ?? build.version,
  };
  const plugin = join(root, 'original');
  cpSync('clients/build', join(plugin, 'bridge'), { recursive: true });
  for (const file of ['manifest.json', 'manifest.v2.json']) {
    const path = join(plugin, 'bridge', file);
    writeFileSync(
      path,
      JSON.stringify({
        ...JSON.parse(readFileSync(path, 'utf8')),
        buildSetId: originalBuild.buildSetId,
        version: originalBuild.version,
      }),
    );
  }
  const runtime = createRealRuntime('prod', { baseDir: join(root, '.coral') });
  const runDir = runtime.paths.coral.coordinator.runDir;
  mkdirSync(runDir, { recursive: true });
  const installed = join(root, 'installed');
  vi.spyOn(registry, 'createPluginRegistry').mockReturnValue({
    installedPluginRoots: () => [installed],
  } as unknown as ReturnType<typeof registry.createPluginRegistry>);
  cpSync('clients/build', join(installed, 'bridge'), { recursive: true });
  const incarnation = probeProcessIncarnation(process.pid)!;
  const capsule = decodeHandoffCapsule(
    Buffer.from(
      JSON.stringify({
        version: 4,
        grantId: '22222222-2222-4222-8222-222222222222',
        secret: 'a'.repeat(64),
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: build.buildSetId,
        controllerBuildSetId: build.buildSetId,
        hostFingerprint: 'd'.repeat(64),
        guardianInstanceId: '33333333-3333-4333-8333-333333333333',
        reaperInstanceId: '44444444-4444-4444-8444-444444444444',
        proxyInstanceId: '55555555-5555-4555-8555-555555555555',
        guardianControlEndpoint: join(runDir, 'g.sock'),
        reaperControlEndpoint: join(runDir, 'r.sock'),
        proxyEndpoint: join(runDir, 'p.sock'),
        orphanTimeoutMs: 30000,
        teardownReserveMs: 14000,
        guardianPid: process.pid,
        reaperPid: process.pid,
        proxyPid: process.pid,
        guardianIncarnation: incarnation,
        reaperIncarnation: incarnation,
        proxyIncarnation: incarnation,
        containmentKind: 'detached-process-group',
        proxyProcessGroupId: process.pid,
      }),
    ),
  );
  const path = providerHandoffCapsulePath(capsule, 4, { baseDir: join(root, '.coral') });
  writeFileSync(path, JSON.stringify(capsule), { mode: 0o600 });
  const record = new SupervisorLaunchMemory(runDir, { pid: process.pid, incarnation }, originalBuild.buildSetId);
  const input = {
    record,
    owner: { current: record.read().owner, lost: false, release: () => {} },
    runDir,
    original: { executable: join(plugin, 'bridge/coral-backend.cjs'), buildSetId: originalBuild.buildSetId },
    originalManifest: originalBuild,
    tried: new Set<string>(),
    firstLaunch: true,
    unidentifiedBinder: { observed: false },
  };
  const clock = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(0n);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return { runtime, runDir, installed, build, capsule, path, input, clock };
}

it.each(['installed', 'missing'] as const)(
  'selects newer original C with a %s completed A-to-B receipt and no refusals',
  async (availability) => {
    const f = fixture('999.0.0');
    rmSync(f.path);
    expect(
      await compareAndSwapUpgradeIntent(f.runDir, null, {
        requestId: 'completed-a-to-b',
        incumbent: {
          instanceId: 'old-a',
          pid: 2147483647,
          incarnation: null,
          version: f.build.version,
          bundleHash: f.build.bundleHash,
          flavor: 'prod',
        },
        target: { build: f.build, pluginRootLabel: f.installed },
        attemptId: 'a-to-b',
        attemptOwner: { kind: 'incumbent', instanceId: 'old-a', pid: 2147483647, incarnation: null },
        disposition: 'completed',
        blockers: [],
        retryCondition: null,
        attemptDeadline: null,
        completionReceipt: {
          kind: 'serving',
          attemptId: 'a-to-b',
          successor: { instanceId: 'b', pid: 2147483646, incarnation: null, build: f.build },
          epochKey: 'epoch:1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: '2026-10-04T00:00:00.000Z',
        },
      }),
    ).toMatchObject({ kind: 'written' });
    if (availability === 'missing') rmSync(f.installed, { recursive: true });
    expect(controllerBuild(f.runDir)).toEqual({ kind: 'none' });
    expect(await selectNextCandidate(f.input)).toEqual({ kind: 'candidate', candidate: f.input.original });
  },
);

it.each(['installed', 'missing'] as const)(
  'requires the %s completed serving build after a capsule read refusal expires',
  async (availability) => {
    const f = fixture();
    expect(
      await compareAndSwapUpgradeIntent(f.runDir, null, {
        requestId: 'completed-a-to-b',
        incumbent: {
          instanceId: 'old-a',
          pid: 2147483647,
          incarnation: null,
          version: f.build.version,
          bundleHash: f.build.bundleHash,
          flavor: 'prod',
        },
        target: { build: f.build, pluginRootLabel: f.installed },
        attemptId: 'a-to-b',
        attemptOwner: { kind: 'incumbent', instanceId: 'old-a', pid: 2147483647, incarnation: null },
        disposition: 'completed',
        blockers: [],
        retryCondition: null,
        attemptDeadline: null,
        completionReceipt: {
          kind: 'serving',
          attemptId: 'a-to-b',
          successor: { instanceId: 'b', pid: 2147483646, incarnation: null, build: f.build },
          epochKey: 'epoch:1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: '2026-10-04T00:00:00.000Z',
        },
      }),
    ).toMatchObject({ kind: 'written' });
    if (availability === 'missing') rmSync(f.installed, { recursive: true });
    vi.spyOn(discovery, 'readProviderHandoffCapsuleCandidate').mockImplementation(() => {
      throw new Error('EIO');
    });
    expect(await selectNextCandidate(f.input)).toEqual({ kind: 'retry' });
    f.clock.mockReturnValue(2_000_000_000n);
    const selected = await selectNextCandidate(f.input);
    if (availability === 'installed')
      expect(selected).toMatchObject({ kind: 'candidate', candidate: { buildSetId: f.build.buildSetId } });
    else {
      expect(selected).toEqual({ kind: 'retry' });
      expect(readLaunchStatus(f.runDir)).toMatchObject({
        kind: 'readable',
        status: { hold: { controller: f.build.buildSetId, retry: 'eligible-build-appears' } },
      });
    }
  },
);

it('keeps capsule and custody refusals while live transfer uncertainty continues to hold', async () => {
  const f = fixture();
  const refused = join(f.runDir, 'provider-1eeeeeeeeeeeeeeeeeeeeeee.handoff.v3.json');
  writeFileSync(refused, '{', { mode: 0o600 });
  const custody = join(custodyLedgerDir(f.runDir), '66666666-6666-4666-8666-666666666666');
  mkdirSync(custody, { recursive: true });
  writeFileSync(join(custody, 'intent.v1.json'), '{');
  vi.spyOn(transfer, 'servedControllerTransferForCapsule').mockReturnValue({ kind: 'unknown' });
  expect(controllerBuild(f.runDir)).toMatchObject({
    kind: 'unknown',
    refusals: expect.arrayContaining([
      { path: refused, observation: 'capsule-unreadable' },
      { path: custody, observation: 'custody-record-unreadable' },
    ]),
  });
  expect(await selectNextCandidate(f.input)).toEqual({ kind: 'retry' });
  f.clock.mockReturnValue(20_000_000_000n);
  expect(await selectNextCandidate(f.input)).toEqual({ kind: 'retry' });
  expect(readLaunchStatus(f.runDir)).toMatchObject({
    kind: 'readable',
    status: { hold: { kind: 'no-eligible-build' } },
  });
  vi.mocked(transfer.servedControllerTransferForCapsule).mockReturnValue({ kind: 'none' });
  expect(await selectNextCandidate(f.input)).toMatchObject({
    kind: 'candidate',
    candidate: { buildSetId: f.build.buildSetId },
  });
});

it('selects a readable live requirement despite another refused capsule', async () => {
  const f = fixture();
  writeFileSync(join(f.runDir, 'provider-1eeeeeeeeeeeeeeeeeeeeeee.handoff.v3.json'), '{', { mode: 0o600 });
  expect(await selectNextCandidate(f.input)).toMatchObject({
    kind: 'candidate',
    candidate: { buildSetId: f.build.buildSetId },
  });
  f.input.tried.add(join(f.installed, 'bridge/coral-backend.cjs'));
  f.clock.mockReturnValue(20_000_000_000n);
  expect(await selectNextCandidate(f.input)).toEqual({ kind: 'retry' });
});

it('holds conflicting readable builds and preserves unrelated refusals after the grace', async () => {
  const f = fixture();
  const other = decodeHandoffCapsule(
    Buffer.from(
      JSON.stringify({
        ...f.capsule,
        controllerBuildSetId: f.input.original.buildSetId,
        proxyInstanceId: '77777777-7777-4777-8777-777777777777',
      }),
    ),
  );
  writeFileSync(providerHandoffCapsulePath(other, 4, { baseDir: join(f.runDir, '../..') }), JSON.stringify(other), {
    mode: 0o600,
  });
  const refused = join(f.runDir, 'provider-1eeeeeeeeeeeeeeeeeeeeeee.handoff.v3.json');
  writeFileSync(refused, '{', { mode: 0o600 });
  expect(controllerBuild(f.runDir)).toMatchObject({
    kind: 'unknown',
    refusals: [{ path: refused, observation: 'capsule-unreadable' }],
  });
  expect(await selectNextCandidate(f.input)).toEqual({ kind: 'retry' });
  f.clock.mockReturnValue(20_000_000_000n);
  expect(await selectNextCandidate(f.input)).toEqual({ kind: 'retry' });
});

it('holds a required controller when only an unrecorded old copy remains', async () => {
  const f = fixture();
  const oldCopy = join(f.runtime.paths.coral.generation.root, 'builds', f.build.buildSetId);
  cpSync(f.installed, oldCopy, { recursive: true });
  rmSync(f.installed, { recursive: true });
  expect(controllerBuild(f.runDir)).toMatchObject({ kind: 'required', buildSetId: f.build.buildSetId });
  expect(await selectNextCandidate(f.input)).toEqual({ kind: 'retry' });
  expect(readFileSync(join(oldCopy, 'bridge', 'coral-backend.cjs'))).toEqual(
    readFileSync('clients/build/coral-backend.cjs'),
  );
});
