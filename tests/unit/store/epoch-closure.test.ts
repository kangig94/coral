import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendLog } from '#src/infra/backend-log.js';

import { JobLocationIndex } from '#src/jobs/location-index.js';
import { formatStoreResetList } from '#src/cli/format/store-reset.js';
import { settleSupersededEpochClosures } from '#src/coordinator/services/recovery/epoch-closure.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import {
  bindCustodyIdentity,
  custodyLedgerDir,
  initializeCustodyLedger,
  recordCustodyIntent,
  reconcileCustodyLedger,
} from '#src/store/custody-ledger.js';
import { readEpochClosure, recordEpochClosure, recordEpochCustodyCoverage } from '#src/store/epoch-closure.js';
import { readOrCreateEpochKey } from '#src/store/epoch-key.js';
import {
  knownProtectedEpochAddresses,
  protectStoreEpoch,
  protectedStoreEpochRoot,
  reconcileProtectedEpochs,
  resolveProtectedEpoch,
} from '#src/store/epoch-protection.js';
import {
  decodeResolvedStoreEpoch,
  discardCurrentStoreEpoch,
  encodeResolvedStoreEpoch,
  epochDirectory,
  epochPath,
  listStoreEpochs,
  openExactStoreEpoch,
  resolvedStoreEpoch,
  storeEpochLockPath,
  sweepStoreEpochsPostReady,
} from '#src/store/epoch.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

const roots: string[] = [];
const storeFormat = currentCoralStoreFormat();
const build = {
  version: storeFormat.productVersion,
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
  flavor: 'prod' as const,
  storeFormatFingerprint: storeFormat.fingerprint,
};

function harness(): Runtime {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-epoch-closure-'));
  roots.push(baseDir);
  return createRealRuntime('prod', { baseDir });
}

function publish(runtime: Runtime, epoch: string, publishedAt = '2026-09-25T00:00:00.000Z'): void {
  const root = runtime.paths.coral.store.dbDir;
  const directory = epochDirectory(root, epoch);
  mkdirSync(directory, { recursive: true });
  writeFileSync(storeEpochLockPath(root, epoch), '');
  openTestStoreDatabase({ path: epochPath(root, epoch), storage: runtime.storage, storeFormat }).close();
  writeFileSync(
    join(directory, 'epoch.json'),
    JSON.stringify({
      supersedes: null,
      classification: { kind: 'absent' },
      build,
      publishedAt,
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('epoch closure and protected addressing', () => {
  it('audits each closure or retention status change once', () => {
    const runtime = harness();
    const stateRoot = runtime.paths.coral.generation.dataRoot;
    mkdirSync(stateRoot, { recursive: true });
    const events: string[] = [];
    vi.spyOn(backendLog, 'info').mockImplementation((message) => {
      if (message.includes('epoch_closure_status_changed')) events.push(message);
    });
    const evidence = {
      version: 'v1' as const,
      epochKey: 'lineage:1',
      disposition: 'unrecoverable-retained' as const,
      dataOutcome: 'unknown' as const,
      executionDischarge: 'undecidable' as const,
      obligations: [],
      reason: 'custody undecidable',
      observedAtMs: 1,
    };
    recordEpochClosure(runtime, stateRoot, evidence);
    recordEpochClosure(runtime, stateRoot, { ...evidence, observedAtMs: 2 });
    recordEpochClosure(runtime, stateRoot, { ...evidence, dataOutcome: 'retained' as const, observedAtMs: 3 });
    expect(events).toHaveLength(2);
  });
  it('retains an unprovable earlier epoch while publishing a successor', () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    unlinkSync(storeEpochLockPath(root, '1'));

    const successor = discardCurrentStoreEpoch(runtime, { storeFormat, build });
    expect(successor.store.epoch).toBe('2');
    successor.db.close();
    expect(existsSync(epochDirectory(root, '1'))).toBe(true);
    expect(existsSync(epochDirectory(root, '2'))).toBe(true);
  });

  it('reconstructs an unpublished address after the move and keeps same-number lineages distinct', () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    const old = resolvedStoreEpoch(root, '1');
    const oldKey = readOrCreateEpochKey(runtime, old);
    const lineage = oldKey.slice(0, oldKey.lastIndexOf(':'));
    const moved = join(dirname(root), '.coral-protected-store-epochs.v1', 'store', lineage, 'epoch-1');
    mkdirSync(dirname(moved), { recursive: true });
    renameSync(dirname(old.path), moved);

    const [address] = reconcileProtectedEpochs(runtime, root);
    expect(address).toMatchObject({ epochKey: oldKey, originalPath: dirname(old.path), protectedPath: moved });
    expect(resolveProtectedEpoch(runtime, root, oldKey)?.path).toBe(join(moved, 'store.db'));
    publish(runtime, '1');
    const newKey = readOrCreateEpochKey(runtime, resolvedStoreEpoch(root, '1'));
    expect(newKey).not.toBe(oldKey);
    expect(readFileSync(join(moved, '.coral-lineage.v1.json'), 'utf8')).toContain(lineage);
    const rows = listStoreEpochs(runtime).filter((entry) => entry.epoch === '1');
    expect(rows.map((entry) => entry.epochKey)).toEqual(expect.arrayContaining([oldKey, newKey]));
    const rendered = formatStoreResetList(
      {
        epochs: rows,
        holders: [],
        residues: [],
        legacyIncidents: [],
        truncated: false,
      },
      'gen2',
    );
    expect(rendered).toContain(oldKey);
    expect(rendered).toContain(newKey);
  });

  it('opens the protected exact epoch by its lineage key', () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    const original = resolvedStoreEpoch(root, '1');
    const lineageKey = readOrCreateEpochKey(runtime, original);
    const address = protectStoreEpoch(runtime, original);
    const opened = openExactStoreEpoch(runtime, { storeFormat, build }, { ...original, lineageKey });
    expect(opened.kind).toBe('opened');
    if (opened.kind === 'opened') {
      expect(opened.store.path).toBe(join(address.protectedPath, 'store.db'));
      expect(decodeResolvedStoreEpoch(runtime, encodeResolvedStoreEpoch(runtime, opened.store))?.path).toBe(
        opened.store.path,
      );
      opened.db.close();
    }
  });

  it('requires closure and released historical results for the exact key before deletion', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    for (const epoch of ['1', '2', '3']) publish(runtime, epoch);
    const key = readOrCreateEpochKey(runtime, resolvedStoreEpoch(root, '1'));
    const stateRoot = runtime.paths.coral.generation.dataRoot;
    const index = new JobLocationIndex(runtime, stateRoot);
    const open = resolvedStoreEpoch(root, '3');

    await sweepStoreEpochsPostReady(runtime, open, { resultsReleased: (epochKey) => index.resultsReleased(epochKey) });
    expect(existsSync(epochDirectory(root, '1'))).toBe(true);

    const otherKey = 'another-lineage:1';
    index.certify(otherKey, 0);
    recordEpochClosure(runtime, stateRoot, {
      version: 'v1',
      epochKey: otherKey,
      disposition: 'closed',
      dataOutcome: 'retained',
      executionDischarge: 'certified',
      obligations: [],
      reason: 'unrelated epoch',
      observedAtMs: 1,
    });
    await sweepStoreEpochsPostReady(runtime, open, { resultsReleased: (epochKey) => index.resultsReleased(epochKey) });
    expect(existsSync(epochDirectory(root, '1'))).toBe(true);

    recordEpochClosure(runtime, stateRoot, {
      version: 'v1',
      epochKey: key,
      disposition: 'closed',
      dataOutcome: 'unknown',
      executionDischarge: 'certified',
      obligations: [],
      reason: 'owner certificate',
      observedAtMs: 1,
    });
    await sweepStoreEpochsPostReady(runtime, open, { resultsReleased: (epochKey) => index.resultsReleased(epochKey) });
    expect(existsSync(epochDirectory(root, '1'))).toBe(true);

    expect(index.certify(key, 0)).not.toBeNull();
    await sweepStoreEpochsPostReady(runtime, open, { resultsReleased: (epochKey) => index.resultsReleased(epochKey) });
    expect(existsSync(epochDirectory(root, '1'))).toBe(false);
    expect(existsSync(join(stateRoot, 'epoch-closure.v1'))).toBe(true);
  });

  it('retains the address map and closure certificate after deleting a protected closed epoch', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1', '2026-09-25T00:00:00.000Z');
    const old = protectStoreEpoch(runtime, resolvedStoreEpoch(root, '1'));
    publish(runtime, '2', '2026-09-25T00:01:00.000Z');
    protectStoreEpoch(runtime, resolvedStoreEpoch(root, '2'));
    publish(runtime, '3', '2026-09-25T00:02:00.000Z');
    const stateRoot = runtime.paths.coral.generation.dataRoot;
    const index = new JobLocationIndex(runtime, stateRoot);
    index.certify(old.epochKey, 0);
    recordEpochClosure(runtime, stateRoot, {
      version: 'v1',
      epochKey: old.epochKey,
      disposition: 'closed',
      dataOutcome: 'retained',
      executionDischarge: 'certified',
      obligations: [],
      reason: 'owner certificate',
      observedAtMs: 1,
    });
    await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(root, '3'), {
      resultsReleased: (epochKey) => index.resultsReleased(epochKey),
    });
    expect(existsSync(old.protectedPath)).toBe(false);
    expect(resolveProtectedEpoch(runtime, root, old.epochKey)?.path).toBe(join(old.protectedPath, 'store.db'));
    expect(knownProtectedEpochAddresses(runtime, root)).toContainEqual(old);
    expect(
      existsSync(
        join(protectedStoreEpochRoot(root), 'addresses', `${Buffer.from(old.epochKey).toString('base64url')}.json`),
      ),
    ).toBe(true);
    expect(readEpochClosure(runtime, stateRoot, old.epochKey)?.disposition).toBe('closed');
  });

  it('finishes a closed protected deletion interrupted after its durable rename', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1', '2026-09-25T00:00:00.000Z');
    const old = protectStoreEpoch(runtime, resolvedStoreEpoch(root, '1'));
    publish(runtime, '2', '2026-09-25T00:01:00.000Z');
    protectStoreEpoch(runtime, resolvedStoreEpoch(root, '2'));
    publish(runtime, '3', '2026-09-25T00:02:00.000Z');
    const stateRoot = runtime.paths.coral.generation.dataRoot;
    const index = new JobLocationIndex(runtime, stateRoot);
    index.certify(old.epochKey, 0);
    recordEpochClosure(runtime, stateRoot, {
      version: 'v1',
      epochKey: old.epochKey,
      disposition: 'closed',
      dataOutcome: 'retained',
      executionDischarge: 'certified',
      obligations: [],
      reason: 'owner certificate',
      observedAtMs: 1,
    });
    const tombstone = join(dirname(old.protectedPath), '.reaping-epoch-1');
    renameSync(old.protectedPath, tombstone);
    await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(root, '3'), {
      resultsReleased: (epochKey) => index.resultsReleased(epochKey),
    });
    expect(existsSync(tombstone)).toBe(false);
    expect(readEpochClosure(runtime, stateRoot, old.epochKey)?.disposition).toBe('closed');
  });

  it('retains undecidable history and a reaping residue even with released results', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    for (const epoch of ['1', '2', '3']) publish(runtime, epoch);
    const key = readOrCreateEpochKey(runtime, resolvedStoreEpoch(root, '1'));
    const stateRoot = runtime.paths.coral.generation.dataRoot;
    const index = new JobLocationIndex(runtime, stateRoot);
    index.certify(key, 0);
    recordEpochClosure(runtime, stateRoot, {
      version: 'v1',
      epochKey: key,
      disposition: 'unrecoverable-retained',
      dataOutcome: 'retained',
      executionDischarge: 'undecidable',
      obligations: [],
      reason: 'custody unreadable',
      observedAtMs: 1,
    });
    const residue = join(root, '.reaping-unknown');
    mkdirSync(residue);
    writeFileSync(join(residue, 'store.db'), 'unattributed bytes');
    await sweepStoreEpochsPostReady(runtime, resolvedStoreEpoch(root, '3'), {
      resultsReleased: (epochKey) => index.resultsReleased(epochKey),
    });
    expect(existsSync(epochDirectory(root, '1'))).toBe(true);
    expect(existsSync(residue)).toBe(true);
  });

  it('records unreadable legacy custody as visible unrecoverable-retained without blocking service', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    publish(runtime, '2');
    const key = readOrCreateEpochKey(runtime, resolvedStoreEpoch(root, '1'));
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const records = await settleSupersededEpochClosures(runtime, index);
    expect(records.find((record) => record.epochKey === key)).toMatchObject({
      disposition: 'unrecoverable-retained',
      executionDischarge: 'undecidable',
    });
    expect(readEpochClosure(runtime, runtime.paths.coral.generation.dataRoot, key)?.disposition).toBe(
      'unrecoverable-retained',
    );
    expect(listStoreEpochs(runtime).find((entry) => entry.epochKey === key)?.closureDisposition).toBe(
      'unrecoverable-retained',
    );
    expect(existsSync(epochDirectory(root, '1'))).toBe(true);
  });

  it('updates retained data outcome without reopening certified execution discharge', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    publish(runtime, '2');
    const key = readOrCreateEpochKey(runtime, resolvedStoreEpoch(root, '1'));
    recordEpochCustodyCoverage(
      runtime,
      epochDirectory(root, '1'),
      initializeCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir),
    );
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    expect((await settleSupersededEpochClosures(runtime, index))[0]).toMatchObject({
      epochKey: key,
      executionDischarge: 'certified',
      dataOutcome: 'unknown',
    });
    index.certify(key, 0);
    expect((await settleSupersededEpochClosures(runtime, index))[0]).toMatchObject({
      epochKey: key,
      executionDischarge: 'certified',
      dataOutcome: 'retained',
    });
  });

  it('closes execution only after the owner custody intent has proven absence', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    publish(runtime, '2');
    const old = resolvedStoreEpoch(root, '1');
    const runDir = runtime.paths.coral.coordinator.runDir;
    recordEpochCustodyCoverage(runtime, dirname(old.path), initializeCustodyLedger(runtime, runDir));
    const key = readOrCreateEpochKey(runtime, old);
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: dirname(old.path),
      owner: 'durable-cli',
      operationId: 'job-1',
      capsule: null,
      bindWithinMs: 1,
      nowMs: 1,
    });
    expect(intent.epochKey).toBe(key);
    expect((await settleSupersededEpochClosures(runtime, index))[0]?.disposition).toBe('unrecoverable-retained');
    reconcileCustodyLedger(runtime, runDir, 3, 1, (candidate) => ({
      kind: 'absent',
      processToken: candidate.processToken,
      evidence: 'same-user token scan found no process',
    }));
    const [closed] = await settleSupersededEpochClosures(runtime, index);
    expect(closed).toMatchObject({
      epochKey: key,
      disposition: 'closed',
      dataOutcome: 'unknown',
      executionDischarge: 'certified',
      obligations: [{ owner: 'durable-cli', intentId: intent.id, outcome: 'absent' }],
    });
  });

  it('uses proxy owner control only after historical results are released', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    publish(runtime, '2');
    const old = resolvedStoreEpoch(root, '1');
    const runDir = runtime.paths.coral.coordinator.runDir;
    recordEpochCustodyCoverage(runtime, dirname(old.path), initializeCustodyLedger(runtime, runDir));
    const key = readOrCreateEpochKey(runtime, old);
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const guardian = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await once(guardian, 'spawn');
    try {
      if (guardian.pid === undefined) throw new Error('Guardian process did not start.');
      const incarnation = runtime.process.readProcessIncarnation(
        guardian.pid,
        runtime.env.platform() as NodeJS.Platform,
      );
      if (incarnation === null) throw new Error('Guardian incarnation was not observable.');
      const intent = recordCustodyIntent(runtime, runDir, {
        effect: 'process-spawn',
        epoch: dirname(old.path),
        owner: 'provider-proxy-set',
        operationId: 'proxy-1:guardian',
        capsule: null,
        bindWithinMs: 10_000,
        nowMs: 1,
      });
      bindCustodyIdentity(runtime, runDir, intent, {
        process: { pid: guardian.pid, incarnation, processGroupId: guardian.pid },
        capsule: null,
        observedAtMs: 2,
      });
      let closeCalls = 0;
      const closeProxySet = async (
        proxyInstanceId: string,
        guardianIdentity: { pid: number; incarnation: typeof incarnation },
      ): Promise<boolean> => {
        expect(proxyInstanceId).toBe('proxy-1');
        expect(guardianIdentity).toMatchObject({ pid: guardian.pid, incarnation });
        closeCalls += 1;
        const exited = once(guardian, 'exit');
        guardian.kill('SIGKILL');
        await exited;
        return true;
      };
      expect(
        (await settleSupersededEpochClosures(runtime, index, undefined, key, undefined, closeProxySet))[0]?.disposition,
      ).toBe('unrecoverable-retained');
      expect(closeCalls).toBe(0);
      index.certify(key, 0);
      expect(
        (await settleSupersededEpochClosures(runtime, index, undefined, key, undefined, closeProxySet))[0],
      ).toMatchObject({ disposition: 'closed', executionDischarge: 'certified' });
      expect(closeCalls).toBe(1);
    } finally {
      if (guardian.exitCode === null && guardian.signalCode === null) guardian.kill('SIGKILL');
    }
  });

  it('counts custody recorded after a protected exact reopen', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    const runDir = runtime.paths.coral.coordinator.runDir;
    recordEpochCustodyCoverage(runtime, epochDirectory(root, '1'), initializeCustodyLedger(runtime, runDir));
    const address = protectStoreEpoch(runtime, resolvedStoreEpoch(root, '1'));
    publish(runtime, '2');
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: address.protectedPath,
      owner: 'durable-cli',
      operationId: 'job-2',
      capsule: null,
      bindWithinMs: 1,
      nowMs: 1,
    });
    reconcileCustodyLedger(runtime, runDir, 3, 1, (candidate) => ({
      kind: 'absent',
      processToken: candidate.processToken,
      evidence: 'recorded token is absent',
    }));
    const records = await settleSupersededEpochClosures(
      runtime,
      new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot),
    );
    expect(records.find((record) => record.epochKey === address.epochKey)?.obligations).toMatchObject([
      { intentId: intent.id, outcome: 'absent' },
    ]);
  });

  it('holds path-only custody when a shipped build reuses the same epoch number', async () => {
    const runtime = harness();
    const root = runtime.paths.coral.store.dbDir;
    publish(runtime, '1');
    const runDir = runtime.paths.coral.coordinator.runDir;
    readOrCreateEpochKey(runtime, resolvedStoreEpoch(root, '1'));
    recordEpochCustodyCoverage(runtime, epochDirectory(root, '1'), initializeCustodyLedger(runtime, runDir));
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: epochDirectory(root, '1'),
      owner: 'durable-cli',
      operationId: 'old-job',
      capsule: null,
      bindWithinMs: 1,
      nowMs: 1,
    });
    const intentPath = join(custodyLedgerDir(runDir), intent.id, 'intent.v1.json');
    const pathOnly = JSON.parse(readFileSync(intentPath, 'utf8')) as Record<string, unknown>;
    delete pathOnly.epochKey;
    writeFileSync(intentPath, JSON.stringify(pathOnly));
    reconcileCustodyLedger(runtime, runDir, 3, 1, (candidate) => ({
      kind: 'absent',
      processToken: candidate.processToken,
      evidence: 'old token absent',
    }));
    const old = protectStoreEpoch(runtime, resolvedStoreEpoch(root, '1'));
    publish(runtime, '1');
    publish(runtime, '2');
    const records = await settleSupersededEpochClosures(
      runtime,
      new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot),
    );
    expect(records.find((record) => record.epochKey === old.epochKey)).toMatchObject({
      disposition: 'unrecoverable-retained',
      reason: 'path-only custody cannot distinguish reused epoch numbers',
    });
  });
});
