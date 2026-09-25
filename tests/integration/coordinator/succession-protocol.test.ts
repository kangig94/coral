import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSuccessionCoordinator } from '#src/coordinator/succession/index.js';
import { readSuccessionCapabilities } from '#src/coordinator/succession/protocol.js';
import type { SuccessionOwner } from '#src/coordinator/succession/obligations.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import {
  CLI_BUNDLE_FILE,
  CURRENT_STRICT_BUNDLE_MANIFEST_FILE,
  SUCCESSION_CAPABILITIES_FILE,
} from '#src/infra/bundle-manifest-address.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';

const roots: string[] = [];

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
  it('reads the separate declaration and treats its absence as an empty acceptance set', () => {
    const target = fixture();
    expect(readSuccessionCapabilities(target.bridge, target.build)).toMatchObject({
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
    expect(readSuccessionCapabilities(target.bridge, target.build)).toMatchObject({ kind: 'declared' });
    writeFileSync(target.declarationPath, JSON.stringify({ ...target.declaration, buildSetId: 'another-build' }));
    expect(readSuccessionCapabilities(target.bridge, target.build)).toEqual({ kind: 'invalid' });
    unlinkSync(target.declarationPath);
    expect(readSuccessionCapabilities(target.bridge, target.build)).toEqual({ kind: 'absent' });
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
      runDir: target.runDir,
      incumbent: {
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      },
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
      reason: 'succession commit capability is not released',
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

  it('blocks every undeclared owner without a capability file', async () => {
    const target = fixture();
    unlinkSync(target.declarationPath);
    const service = createSuccessionCoordinator({
      runDir: target.runDir,
      incumbent: {
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      },
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
      blockers: [{ owner: 'launch-admission', reason: 'target does not declare this owner contract' }],
    });
  });

  it('does not record a rollback or equal-version request', async () => {
    const target = fixture();
    const service = createSuccessionCoordinator({
      runDir: target.runDir,
      incumbent: {
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '2.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      },
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
    const serving = { epochKey: 'epoch-one', controlGeneration: 1, successorInstanceId: 'successor' };
    const service = createSuccessionCoordinator({
      runDir: target.runDir,
      incumbent: {
        instanceId: 'incumbent',
        pid: 100,
        incarnation: null,
        version: '1.0.0',
        bundleHash: 'old-bundle',
        flavor: 'prod',
      },
      owners: [],
      requiredOwners: [],
      epochKey: () => 'epoch-one',
      admissionRevision: () => 0,
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
    const observed = readUpgradeIntent(target.runDir);
    if (observed.kind !== 'readable') throw new Error('expected durable intent');
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
      recordedAt: new Date().toISOString(),
    };
    expect(
      await compareAndSwapUpgradeIntent(target.runDir, observed.intent.revision, {
        ...observed.intent,
        disposition: 'completed',
        completionReceipt: receipt,
      }),
    ).toMatchObject({ kind: 'written' });

    expect(await service.reconciler.commit('attempt')).toEqual({ kind: 'committed', receipt });
    expect(await service.reconciler.commit('attempt')).toEqual({ kind: 'committed', receipt });
    expect(await service.reconciler.abort('attempt')).toEqual({
      kind: 'refused',
      reason: 'attempt already serves',
    });
  });
});
