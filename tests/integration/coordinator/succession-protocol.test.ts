import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSuccessionCoordinator } from '#src/coordinator/succession/index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { readSuccessionCapabilities } from '#src/coordinator/succession/protocol.js';
import type { SuccessionOwner } from '#src/coordinator/succession/obligations.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import {
  CLI_BUNDLE_FILE,
  CURRENT_STRICT_BUNDLE_MANIFEST_FILE,
  SUCCESSION_CAPABILITIES_FILE,
} from '#src/infra/bundle-manifest-address.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const runtime = createRealRuntime('prod', { baseDir: tmpdir() });

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-succession-'));
  roots.push(root);
  const runDir = join(root, 'run');
  const pluginRoot = join(root, 'target');
  const bridge = join(pluginRoot, 'bridge');
  mkdirSync(bridge, { recursive: true });
  const bundles = [
    ['coral-backend.cjs', 'backend'],
    [CLI_BUNDLE_FILE, 'cli'],
    ['coral-claude-appserver.cjs', 'appserver'],
    ['coral-durable-wrapper.cjs', 'wrapper'],
  ] as const;
  for (const [name, body] of bundles) writeFileSync(join(bridge, name), body);
  const build: StrictBundleManifest = {
    version: '2.0.0',
    buildSetId: '123e4567-e89b-42d3-a456-426614174000',
    flavor: 'prod',
    storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
    bundleHash: hash('backend'),
    cliBundleHash: hash('cli'),
    claudeAppserverBundleHash: hash('appserver'),
    durableWrapperBundleHash: hash('wrapper'),
  };
  writeFileSync(join(bridge, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(build));
  const declaration = {
    version: 'v1' as const,
    buildSetId: build.buildSetId,
    bundleHash: build.bundleHash,
    protocols: ['prepare', 'commit'] as const,
    accepts: [{ owner: 'launch-admission', generation: 1 }],
  };
  const declarationPath = join(bridge, SUCCESSION_CAPABILITIES_FILE);
  writeFileSync(declarationPath, JSON.stringify(declaration));
  return { root, runDir, pluginRoot, bridge, build, declaration, declarationPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('succession protocol', () => {
  it('defers a format-changing successor while a job is live and prepares after settlement', async () => {
    const target = fixture();
    let liveJobs = ['job-in-old-epoch'];
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [{ id: 'launch-admission', classify: async () => ({ kind: 'completed', reason: 'idle' }) }],
      requiredOwners: ['launch-admission'],
      liveJobIds: () => liveJobs,
      storeFormatFingerprint: `sha256:${'b'.repeat(64)}`,
      epochKey: () => 'old-epoch',
      admissionRevision: () => 0,
    });
    try {
      await service.reconciler.request({
        requestId: 'format-change',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      });
      expect(await service.reconciler.prepare('format-change')).toMatchObject({
        kind: 'deferred',
        blockers: [{ owner: 'jobs', reason: 'blocking(format): job-in-old-epoch' }],
      });
      liveJobs = [];
      expect(await service.reconciler.prepare('format-change')).toMatchObject({
        kind: 'prepared',
        preparation: { epochKey: 'old-epoch', receipts: [] },
      });
    } finally {
      service.reconciler.dispose();
    }
  });

  it('launches the prepared target after its final obligation settles without another contender', async () => {
    const target = fixture();
    let blocked = true;
    const launchPrepared = vi.fn(async () => ({ settled: new Promise<never>(() => undefined) }));
    const owner: SuccessionOwner = {
      id: 'launch-admission',
      classify: async () =>
        blocked
          ? { kind: 'blocking', reason: 'accepted job is running' }
          : { kind: 'completed', reason: 'accepted job settled' },
    };
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [owner],
      requiredOwners: [owner.id],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      commitAvailable: true,
      launchPrepared,
    });
    try {
      expect(
        await service.reconciler.request({
          requestId: 'request',
          target: { build: target.build, pluginRootLabel: target.pluginRoot },
        }),
      ).toMatchObject({ kind: 'registered' });
      expect(await service.reconciler.reconcile()).toMatchObject({ kind: 'deferred' });
      expect(launchPrepared).not.toHaveBeenCalled();

      blocked = false;
      service.reconciler.notifyObligationChange();
      await waitForCondition(() => launchPrepared.mock.calls.length === 1);
      expect(launchPrepared).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'request' }),
        expect.objectContaining({ stage: 'prepared', receipts: [] }),
      );
    } finally {
      service.reconciler.dispose();
    }
  });

  it('re-reconciles an obligation change that arrives during a pass instead of waiting for the retry cadence', async () => {
    const target = fixture();
    let blocked = true;
    let observeStaleClassify!: () => void;
    const staleClassifyEntered = new Promise<void>((resolve) => {
      observeStaleClassify = resolve;
    });
    let releaseStaleClassify!: () => void;
    const staleClassifyGate = new Promise<void>((resolve) => {
      releaseStaleClassify = resolve;
    });
    const launchPrepared = vi.fn(async () => ({ settled: new Promise<never>(() => undefined) }));
    const owner: SuccessionOwner = {
      id: 'launch-admission',
      classify: async () => {
        const observedBlocked = blocked;
        if (observedBlocked) {
          observeStaleClassify();
          await staleClassifyGate;
          return { kind: 'blocking', reason: 'accepted job is running' };
        }
        return { kind: 'completed', reason: 'accepted job settled' };
      },
    };
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [owner],
      requiredOwners: [owner.id],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      commitAvailable: true,
      launchPrepared,
      retryIntervalMs: 3_600_000,
    });
    try {
      expect(
        await service.reconciler.request({
          requestId: 'request',
          target: { build: target.build, pluginRootLabel: target.pluginRoot },
        }),
      ).toMatchObject({ kind: 'registered' });
      await staleClassifyEntered;

      blocked = false;
      service.reconciler.notifyObligationChange();
      await Promise.resolve();
      releaseStaleClassify();

      await waitForCondition(() => launchPrepared.mock.calls.length === 1, 5_000);
      expect(launchPrepared).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'request' }),
        expect.objectContaining({ stage: 'prepared', receipts: [] }),
      );
    } finally {
      service.reconciler.dispose();
    }
  });

  it('classifies readiness after a launch landed during the readiness window as an obligation change', async () => {
    const target = fixture();
    let admissionRevision = 0;
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [{ id: 'launch-admission', classify: async () => ({ kind: 'completed', reason: 'idle' }) }],
      requiredOwners: ['launch-admission'],
      epochKey: () => 'epoch-one',
      admissionRevision: () => admissionRevision,
    });
    try {
      await service.reconciler.request({
        requestId: 'request',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      });
      const prepared = await service.reconciler.prepare('request');
      if (prepared.kind !== 'prepared') throw new Error(`preparation was ${prepared.kind}`);
      admissionRevision = 1;

      expect(
        await service.reconciler.reportReady({
          attemptId: prepared.preparation.attemptId,
          successorPid: 200,
          targetKey: prepared.preparation.targetKey,
          epochKey: prepared.preparation.epochKey,
          admissionRevision: prepared.preparation.admissionRevision,
          receiptIds: [],
        }),
      ).toEqual({ kind: 'stale', reason: 'preparation is stale', cause: 'obligation-change' });
    } finally {
      service.reconciler.dispose();
    }
  });

  it('reports no incumbent commit capability when the registered target declares preparation only', async () => {
    const target = fixture();
    writeFileSync(target.declarationPath, JSON.stringify({ ...target.declaration, protocols: ['prepare'] }));
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      commitAvailable: true,
    });
    expect(
      await service.dispatch('coordinator.succession.v1.request', {
        requestId: 'request',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      }),
    ).toMatchObject({ kind: 'registered', incumbentCanCommit: false });
    service.reconciler.dispose();
  });

  it.each([
    ['blocking', async () => ({ kind: 'blocking' as const, reason: 'owner still holds work' })],
    [
      'unavailable',
      async () => {
        throw new Error('owner inventory failed');
      },
    ],
  ])('refuses preparation when an owner is %s', async (_case, classify) => {
    const target = fixture();
    const owner: SuccessionOwner = { id: 'launch-admission', classify };
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [owner],
      requiredOwners: [owner.id],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      liveJobIds: () => ['external-without-status'],
    });
    expect(
      await service.reconciler.request({
        requestId: 'request',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      }),
    ).toMatchObject({ kind: 'registered' });
    expect(await service.reconciler.prepare('request')).toMatchObject({
      kind: 'deferred',
      blockers: expect.arrayContaining([{ owner: 'jobs', reason: 'unclaimed: external-without-status' }]),
    });
  });

  it('rechecks owner dispositions before reusing a prepared attempt', async () => {
    const target = fixture();
    let blocked = false;
    const owner: SuccessionOwner = {
      id: 'launch-admission',
      classify: async () =>
        blocked
          ? { kind: 'blocking', reason: 'new carrier acquisition' }
          : { kind: 'completed', reason: 'no admission work' },
    };
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [owner],
      requiredOwners: [owner.id],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
    });
    await service.reconciler.request({
      requestId: 'request',
      target: { build: target.build, pluginRootLabel: target.pluginRoot },
    });
    expect(await service.reconciler.prepare('request')).toMatchObject({ kind: 'prepared' });
    blocked = true;
    expect(await service.reconciler.prepare('request')).toMatchObject({
      kind: 'deferred',
      blockers: [{ owner: 'launch-admission', reason: 'new carrier acquisition' }],
    });
  });

  it('reads the separate declaration and treats its absence as an empty acceptance set', () => {
    const target = fixture();
    expect(readSuccessionCapabilities(runtime, target.bridge, target.build)).toMatchObject({
      kind: 'declared',
      capabilities: { accepts: [{ owner: 'launch-admission', generation: 1 }] },
    });
    expect(
      JSON.parse(readFileSync(join(target.bridge, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')),
    ).not.toHaveProperty('succession');
    writeFileSync(
      target.declarationPath,
      JSON.stringify({
        ...target.declaration,
        protocols: ['prepare', 'future-capability'],
        accepts: [{ owner: 'launch-admission', generation: 1, futureField: true }],
      }),
    );
    expect(readSuccessionCapabilities(runtime, target.bridge, target.build)).toMatchObject({ kind: 'declared' });
    writeFileSync(target.declarationPath, JSON.stringify({ ...target.declaration, buildSetId: 'another-build' }));
    expect(readSuccessionCapabilities(runtime, target.bridge, target.build)).toEqual({ kind: 'invalid' });
    unlinkSync(target.declarationPath);
    expect(readSuccessionCapabilities(runtime, target.bridge, target.build)).toEqual({ kind: 'absent' });
  });

  it('converges concurrent requests and keeps a lost preparation reply bound to one attempt', async () => {
    const target = fixture();
    let epoch = 'epoch-one';
    let admissionRevision = 0;
    let minted = 0;
    const owner: SuccessionOwner = {
      id: 'launch-admission',
      classify: async (attemptId) => ({
        kind: 'transferable',
        reason: 'prepared',
        receipt: {
          owner: 'launch-admission',
          generation: 1,
          attemptId,
          receiptId: `receipt-${attemptId}`,
          recoveryGrantId: `grant-${attemptId}`,
          payload: {},
        },
      }),
    };
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [owner],
      requiredOwners: [owner.id],
      epochKey: () => epoch,
      admissionRevision: () => admissionRevision,
      newAttemptId: () => `attempt-${++minted}`,
    });
    const input = { target: { build: target.build, pluginRootLabel: target.pluginRoot } };
    const requests = await Promise.all([
      service.reconciler.request({ requestId: 'first', ...input }),
      service.reconciler.request({ requestId: 'second', ...input }),
    ]);
    expect(requests.map((result) => result.kind)).toEqual(['registered', 'registered']);
    const observed = readUpgradeIntent(target.runDir);
    expect(observed.kind).toBe('readable');
    if (observed.kind !== 'readable') return;
    const requestId = observed.intent.requestId;
    const first = await service.reconciler.prepare(requestId);
    const retry = await service.reconciler.prepare(requestId);
    expect(first.kind).toBe('prepared');
    expect(retry).toEqual(first);
    if (first.kind !== 'prepared') return;
    expect(first.preparation).toMatchObject({
      incumbentInstanceId: 'incumbent',
      incumbentPid: 100,
      epochKey: epoch,
      admissionRevision: 0,
      accepts: [{ owner: 'launch-admission', generation: 1 }],
      receipts: [{ owner: 'launch-admission', recoveryGrantId: `grant-${first.preparation.attemptId}` }],
    });
    const ready = {
      attemptId: first.preparation.attemptId,
      successorPid: 200,
      targetKey: first.preparation.targetKey,
      epochKey: first.preparation.epochKey,
      admissionRevision: first.preparation.admissionRevision,
      receiptIds: first.preparation.receipts.map((receipt) => receipt.receiptId),
    };
    expect(await service.reconciler.reportReady({ ...ready, epochKey: 'wrong-epoch' })).toEqual({
      kind: 'refused',
      reason: 'successor ready report does not match the prepared attempt',
    });
    expect(await service.reconciler.reportReady(ready)).toMatchObject({ kind: 'ready' });
    expect(await service.reconciler.reportReady(ready)).toMatchObject({ kind: 'ready' });
    expect(await service.reconciler.commit(first.preparation.attemptId)).toEqual({
      kind: 'deferred',
      reason: 'awaiting durable serving record',
    });
    expect(service.reconciler.status()).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'pending', completionReceipt: null },
    });

    admissionRevision++;
    expect(await service.reconciler.commit(first.preparation.attemptId)).toEqual({
      kind: 'refused',
      reason: 'preparation is stale',
    });
    expect(service.reconciler.status()).toMatchObject({
      kind: 'readable',
      intent: { disposition: 'deferred', blockers: [{ owner: 'preparation', reason: 'preparation is stale' }] },
    });
    admissionRevision--;
    epoch = 'epoch-two';
    expect(await service.reconciler.commit(first.preparation.attemptId)).toEqual({
      kind: 'refused',
      reason: 'preparation is stale',
    });
    epoch = 'epoch-one';
    writeFileSync(target.declarationPath, JSON.stringify({ ...target.declaration, accepts: [] }));
    expect(await service.reconciler.commit(first.preparation.attemptId)).toEqual({
      kind: 'refused',
      reason: 'preparation is stale',
    });
    writeFileSync(target.declarationPath, JSON.stringify(target.declaration));
    const current = readUpgradeIntent(target.runDir);
    if (current.kind !== 'readable') throw new Error('expected durable intent');
    await compareAndSwapUpgradeIntent(target.runDir, current.intent.revision, {
      ...current.intent,
      target: { ...current.intent.target, pluginRootLabel: join(target.root, 'changed-target') },
    });
    expect(await service.reconciler.commit(first.preparation.attemptId)).toEqual({
      kind: 'refused',
      reason: 'preparation is stale',
    });
    expect(await service.reconciler.abort(first.preparation.attemptId)).toEqual({ kind: 'aborted' });
    expect(service.reconciler.status()).toMatchObject({
      kind: 'readable',
      preparation: null,
      intent: { disposition: 'pending', attemptId: null },
    });
  });

  it('blocks preparation without a capability file', async () => {
    const target = fixture();
    unlinkSync(target.declarationPath);
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [{ id: 'launch-admission', classify: async () => ({ kind: 'completed', reason: 'empty' }) }],
      requiredOwners: ['launch-admission'],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
    });
    await service.reconciler.request({
      requestId: 'request',
      target: { build: target.build, pluginRootLabel: target.pluginRoot },
    });
    expect(await service.reconciler.prepare('request')).toMatchObject({
      kind: 'deferred',
      blockers: [{ owner: 'protocol', reason: 'target cannot prepare succession' }],
    });
  });

  it('does not record a rollback or equal-version request', async () => {
    const target = fixture();
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '2.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
    });
    expect(
      await service.reconciler.request({
        requestId: 'equal',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      }),
    ).toEqual({ kind: 'refused', reason: 'target does not strictly outrank the incumbent' });
    expect(
      await service.reconciler.request({
        requestId: 'rollback',
        target: { build: { ...target.build, version: '1.0.0' }, pluginRootLabel: target.pluginRoot },
      }),
    ).toEqual({ kind: 'refused', reason: 'target does not strictly outrank the incumbent' });
    expect(readUpgradeIntent(target.runDir)).toEqual({ kind: 'absent' });
  });

  it('recovers the committed answer from a durable serving receipt after a lost reply', async () => {
    const target = fixture();
    let admissionRevision = 0;
    let serving: {
      epochKey: string;
      controlGeneration: number;
      successorInstanceId: string;
      recordedAt: string;
    } | null = null;
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => admissionRevision,
      newAttemptId: () => 'attempt',
      observeServing: () => serving,
    });
    await service.reconciler.request({
      requestId: 'request',
      target: { build: target.build, pluginRootLabel: target.pluginRoot },
    });
    const prepared = await service.reconciler.prepare('request');
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') return;
    const report = {
      attemptId: prepared.preparation.attemptId,
      successorPid: 200,
      targetKey: prepared.preparation.targetKey,
      epochKey: prepared.preparation.epochKey,
      admissionRevision: prepared.preparation.admissionRevision,
      receiptIds: [],
    };
    await service.reconciler.reportReady(report);
    serving = {
      epochKey: 'epoch-one',
      controlGeneration: 1,
      successorInstanceId: 'successor',
      recordedAt: new Date().toISOString(),
    };
    const receipt = {
      kind: 'serving' as const,
      attemptId: 'attempt',
      successor: {
        instanceId: 'successor',
        pid: 200,
        incarnation: null,
        build: target.build,
      },
      epochKey: 'epoch-one',
      controlGeneration: 1,
      acceptedObligations: [],
      recordedAt: serving.recordedAt,
    };
    admissionRevision++;
    expect(
      await service.reconciler.request({
        requestId: 'later-contender',
        target: { build: { ...target.build, version: '3.0.0' }, pluginRootLabel: target.pluginRoot },
      }),
    ).toMatchObject({ kind: 'registered', intent: { requestId: 'request' } });
    // The pass the request wakes records the receipt the serving attempt owes.
    await waitForCondition(() => {
      const observed = readUpgradeIntent(target.runDir);
      return observed.kind === 'readable' && observed.intent.disposition === 'completed';
    }, 5_000);
    expect(await service.reconciler.commit('attempt')).toEqual({ kind: 'committed', receipt });
    expect(await service.reconciler.commit('attempt')).toEqual({ kind: 'committed', receipt });
    expect(await service.reconciler.abort('attempt')).toEqual({
      kind: 'refused',
      reason: 'attempt already serves',
    });
  });

  it('leaves a launched attempt to its commit when admission changes before readiness', async () => {
    const target = fixture();
    let admissionRevision = 0;
    let minted = 0;
    const launched: string[] = [];
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [{ id: 'launch-admission', classify: async () => ({ kind: 'completed', reason: 'idle' }) }],
      requiredOwners: ['launch-admission'],
      epochKey: () => 'epoch-one',
      admissionRevision: () => admissionRevision,
      commitAvailable: true,
      newAttemptId: () => `attempt-${++minted}`,
      retryIntervalMs: 3_600_000,
      // Like the committer, one supervised attempt at a time; this one never settles.
      launchPrepared: async (_intent, preparation) => {
        if (launched.length > 0) throw new Error('Another succession attempt is active.');
        launched.push(preparation.attemptId);
        return { settled: new Promise<never>(() => undefined) };
      },
    });
    try {
      await service.reconciler.request({
        requestId: 'request',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      });
      await waitForCondition(() => launched.length === 1, 5_000);
      await service.reconciler.reconcile();

      admissionRevision = 1;
      await service.reconciler.reconcile().catch(() => undefined);
      await service.reconciler.reconcile().catch(() => undefined);

      expect(launched).toEqual(['attempt-1']);
      expect(service.reconciler.status()).toMatchObject({
        kind: 'readable',
        intent: { attemptId: 'attempt-1', disposition: 'pending' },
      });
    } finally {
      service.reconciler.dispose();
    }
  });

  it('keeps a committing attempt when a newer target is requested', async () => {
    const target = fixture();
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      newAttemptId: () => 'attempt',
    });
    try {
      await service.reconciler.request({
        requestId: 'request',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      });
      expect(await service.reconciler.prepare('request')).toMatchObject({ kind: 'prepared' });
      const prepared = readUpgradeIntent(target.runDir);
      if (prepared.kind !== 'readable') throw new Error('prepared intent is unreadable');
      const committing = await compareAndSwapUpgradeIntent(target.runDir, prepared.intent.revision, {
        ...prepared.intent,
        disposition: 'attempting',
        attemptDeadline: new Date(Date.now() + 60_000).toISOString(),
      });
      if (committing.kind !== 'written') throw new Error(`committing write was ${committing.kind}`);

      expect(
        await service.reconciler.request({
          requestId: 'newer',
          target: { build: { ...target.build, version: '3.0.0' }, pluginRootLabel: target.pluginRoot },
        }),
      ).toMatchObject({ kind: 'registered', intent: { requestId: 'request' } });
      expect(readUpgradeIntent(target.runDir)).toMatchObject({
        kind: 'readable',
        intent: {
          requestId: 'request',
          attemptId: 'attempt',
          disposition: 'attempting',
          attemptOwner: { kind: 'incumbent', instanceId: 'incumbent' },
        },
      });
    } finally {
      service.reconciler.dispose();
    }
  });

  it('records the completion receipt of an attempt it serves although another incumbent recorded it', async () => {
    const target = fixture();
    const incumbent = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      newAttemptId: () => 'attempt',
    });
    await incumbent.reconciler.request({
      requestId: 'request',
      target: { build: target.build, pluginRootLabel: target.pluginRoot },
    });
    const prepared = await incumbent.reconciler.prepare('request');
    if (prepared.kind !== 'prepared') throw new Error(`preparation was ${prepared.kind}`);
    expect(
      await incumbent.reconciler.reportReady({
        attemptId: 'attempt',
        successorPid: 200,
        targetKey: prepared.preparation.targetKey,
        epochKey: prepared.preparation.epochKey,
        admissionRevision: prepared.preparation.admissionRevision,
        receiptIds: [],
      }),
    ).toMatchObject({ kind: 'ready' });
    incumbent.reconciler.dispose();

    const recordedAt = new Date().toISOString();
    const successor = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'successor',
        pid: 200,
        incarnation: null,
        version: target.build.version,
        bundleHash: target.build.bundleHash,
        flavor: 'prod',
      }),
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      commitAvailable: true,
      retryIntervalMs: 3_600_000,
      observeServing: (attemptId) =>
        attemptId === 'attempt'
          ? { epochKey: 'epoch-one', controlGeneration: 2, successorInstanceId: 'successor', recordedAt }
          : null,
    });
    try {
      expect(await successor.reconciler.reconcile()).toMatchObject({
        kind: 'committed',
        receipt: { attemptId: 'attempt', successor: { instanceId: 'successor' } },
      });
      expect(readUpgradeIntent(target.runDir)).toMatchObject({
        kind: 'readable',
        intent: { disposition: 'completed', completionReceipt: { attemptId: 'attempt' } },
      });
    } finally {
      successor.reconciler.dispose();
    }
  });

  it('adopts a newer target requested during a commit once that commit completes', async () => {
    const target = fixture();
    const incumbent = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      newAttemptId: () => 'attempt',
    });
    await incumbent.reconciler.request({
      requestId: 'request',
      target: { build: target.build, pluginRootLabel: target.pluginRoot },
    });
    const prepared = await incumbent.reconciler.prepare('request');
    if (prepared.kind !== 'prepared') throw new Error(`preparation was ${prepared.kind}`);
    await incumbent.reconciler.reportReady({
      attemptId: 'attempt',
      successorPid: 200,
      targetKey: prepared.preparation.targetKey,
      epochKey: prepared.preparation.epochKey,
      admissionRevision: prepared.preparation.admissionRevision,
      receiptIds: [],
    });
    const ready = readUpgradeIntent(target.runDir);
    if (ready.kind !== 'readable') throw new Error('ready intent is unreadable');
    const committing = await compareAndSwapUpgradeIntent(target.runDir, ready.intent.revision, {
      ...ready.intent,
      disposition: 'attempting',
      attemptDeadline: new Date(Date.now() + 60_000).toISOString(),
    });
    if (committing.kind !== 'written') throw new Error(`committing write was ${committing.kind}`);
    const newer = { build: { ...target.build, version: '3.0.0' }, pluginRootLabel: target.pluginRoot };
    expect(await incumbent.reconciler.request({ requestId: 'newer', target: newer })).toMatchObject({
      kind: 'registered',
      intent: { requestId: 'request', attemptId: 'attempt', disposition: 'attempting' },
    });
    incumbent.reconciler.dispose();

    const recordedAt = new Date().toISOString();
    const successor = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'successor',
        pid: 200,
        incarnation: null,
        version: target.build.version,
        bundleHash: target.build.bundleHash,
        flavor: 'prod',
      }),
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      commitAvailable: true,
      retryIntervalMs: 3_600_000,
      observeServing: (attemptId) =>
        attemptId === 'attempt'
          ? { epochKey: 'epoch-one', controlGeneration: 2, successorInstanceId: 'successor', recordedAt }
          : null,
    });
    try {
      await waitForCondition(() => {
        const observed = readUpgradeIntent(target.runDir);
        return observed.kind === 'readable' && observed.intent.requestId === 'newer';
      }, 5_000);
      expect(readUpgradeIntent(target.runDir)).toMatchObject({
        kind: 'readable',
        intent: {
          requestId: 'newer',
          incumbent: { instanceId: 'successor' },
          target: { build: { version: '3.0.0' } },
          attemptId: null,
          completionReceipt: null,
        },
      });
    } finally {
      successor.reconciler.dispose();
    }
  });

  it('adopts a newer target requested during a commit once that commit fails and is reclaimed', async () => {
    const target = fixture();
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      newAttemptId: () => 'attempt',
      commitAvailable: true,
      retryIntervalMs: 3_600_000,
    });
    try {
      await service.reconciler.request({
        requestId: 'request',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      });
      expect(await service.reconciler.prepare('request')).toMatchObject({ kind: 'prepared' });
      const prepared = readUpgradeIntent(target.runDir);
      if (prepared.kind !== 'readable') throw new Error('prepared intent is unreadable');
      const committing = await compareAndSwapUpgradeIntent(target.runDir, prepared.intent.revision, {
        ...prepared.intent,
        disposition: 'attempting',
        attemptDeadline: new Date(Date.now() + 60_000).toISOString(),
      });
      if (committing.kind !== 'written') throw new Error(`committing write was ${committing.kind}`);
      const newer = { build: { ...target.build, version: '3.0.0' }, pluginRootLabel: target.pluginRoot };
      await service.reconciler.request({ requestId: 'newer', target: newer });

      const held = readUpgradeIntent(target.runDir);
      if (held.kind !== 'readable') throw new Error('held intent is unreadable');
      expect(held.intent.nextTarget).toMatchObject({ requestId: 'newer' });
      // The commit settles its failure the way a reclaim records it, keeping every field it does not own.
      const reclaimed = await compareAndSwapUpgradeIntent(target.runDir, held.intent.revision, {
        ...held.intent,
        disposition: 'deferred',
        attemptId: null,
        attemptChild: null,
        attemptOwner: null,
        attemptDeadline: null,
        successionPreparation: null,
        blockers: [{ owner: 'succession-commit', reason: 'incumbent reclaimed after a failed window' }],
        retryCondition: { kind: 'target-change', evidence: 'successor committed-open failure' },
      });
      if (reclaimed.kind !== 'written') throw new Error(`reclaim write was ${reclaimed.kind}`);
      await service.reconciler.reconcile();
      await waitForCondition(() => {
        const observed = readUpgradeIntent(target.runDir);
        return observed.kind === 'readable' && observed.intent.requestId === 'newer';
      }, 2_000);

      expect(readUpgradeIntent(target.runDir)).toMatchObject({
        kind: 'readable',
        intent: { requestId: 'newer', target: { build: { version: '3.0.0' } } },
      });
    } finally {
      service.reconciler.dispose();
    }
  });

  it('re-certifies only the owners its target cannot accept, and reports one that no longer completes', async () => {
    const target = fixture();
    let discussLive = false;
    const acceptedClassifications: string[] = [];
    const service = createSuccessionCoordinator({
      runtime,
      runDir: target.runDir,
      incumbent: () => ({
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      }),
      owners: [
        {
          id: 'launch-admission',
          classify: async (attemptId) => {
            acceptedClassifications.push(attemptId);
            return { kind: 'completed', reason: 'idle' };
          },
        },
        {
          id: 'discuss',
          classify: async () =>
            discussLive
              ? { kind: 'blocking', reason: 'live discuss session retains coordinator-local state' }
              : { kind: 'completed', reason: 'no live discuss session' },
        },
      ],
      requiredOwners: ['launch-admission', 'discuss'],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
      newAttemptId: () => 'attempt',
    });
    try {
      await service.reconciler.request({
        requestId: 'request',
        target: { build: target.build, pluginRootLabel: target.pluginRoot },
      });
      const prepared = await service.reconciler.prepare('request');
      if (prepared.kind !== 'prepared') throw new Error(`preparation was ${prepared.kind}`);
      expect(await service.reconciler.recertify('attempt')).toEqual(prepared);

      discussLive = true;
      acceptedClassifications.length = 0;
      expect(await service.reconciler.recertify('attempt')).toEqual({
        kind: 'deferred',
        reason: 'succession obligations began after preparation',
        blockers: [{ owner: 'discuss', reason: 'live discuss session retains coordinator-local state' }],
      });
      expect(acceptedClassifications).toEqual([]);
      expect(await service.reconciler.recertify('another-attempt')).toMatchObject({ kind: 'refused' });
    } finally {
      service.reconciler.dispose();
    }
  });
});
