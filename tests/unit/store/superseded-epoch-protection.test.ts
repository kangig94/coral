import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { withSupersededEpochClosures, type BackendStatusFull } from '#src/cli/backend-status.js';
import { readPendingProtections, recordPendingProtection } from '#src/store/epoch/pending-protection.js';
import * as epochProtection from '#src/store/epoch/protection.js';
import {
  discardCurrentStoreEpoch,
  encodeResolvedStoreEpoch,
  epochDirectory,
  epochPath,
  listStoreEpochs,
  mintRetiredStoreEpoch,
  retirementMintDisposition,
  settleStoreEpoch,
  storeEpochLockPath,
  sweepStoreEpochsPostReady,
} from '#src/store/epoch/index.js';
import { createSharedFileLockSync } from '#src/infra/fs-lock.js';
import { sha256Hex } from '#src/infra/hash.js';
import { joinSuccessionWriterGeneration, refuseSuccessionAttempt } from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { authorizeFixtureStoreMint, openTestStoreDatabase } from '#tests/helpers/store-db.js';

const roots: string[] = [];
const format = currentCoralStoreFormat();
const build = {
  version: format.productVersion,
  buildSetId: '00000000-0000-4000-8000-000000000001',
  flavor: 'prod' as const,
  storeFormatFingerprint: format.fingerprint,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('superseded epoch protection', () => {
  it('does not publish when refusal arrives after authorization but before publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-retirement-mint-refusal-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const settled = settleStoreEpoch(runtime, {
      storeFormat: format,
      build,
      authorizeMint: authorizeFixtureStoreMint,
    });
    settled.db.close();
    const expected = joinSuccessionWriterGeneration(runtime, settled.store).generation;
    const epochKey = encodeResolvedStoreEpoch(runtime, settled.store);
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    epochProtection.protectStoreEpoch(runtime, settled.store);
    const attemptId = 'refused-at-retirement-publication';
    const write = runtime.storage.writeAtomicDurableSync;
    let refusalRecorded = false;
    let published = false;
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, ...args) => {
      if (!refusalRecorded && path.endsWith('.retirement-attempt.v1.json')) {
        refusalRecorded = true;
        refuseSuccessionAttempt(runtime, attemptId);
      }
      return write(path, ...args);
    });
    const rename = runtime.storage.renameSync;
    vi.spyOn(runtime.storage, 'renameSync').mockImplementation((from, to) => {
      if (to === epochDirectory(dbDir, '2')) published = true;
      return rename(from, to);
    });
    const newerFormat = {
      ...format,
      productVersion: '0.11.0',
      fingerprint: `sha256:${'0'.repeat(64)}` as const,
    };

    await expect(
      mintRetiredStoreEpoch(runtime, { storeFormat: newerFormat, build }, epochKey, attemptId, expected, () => {}),
    ).rejects.toThrow();

    expect(refusalRecorded).toBe(true);
    expect(published).toBe(false);
    expect(existsSync(epochDirectory(dbDir, '2'))).toBe(false);
  });

  it('should protect an epoch that will not open before publishing its successor when nothing holds it', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-superseded-protection-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
    settled.db.close();
    encodeResolvedStoreEpoch(runtime, settled.store);
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    const unopenable = join(epochDirectory(dbDir, '1'), 'store.db');
    chmodSync(unopenable, 0o000);

    const successor = settleStoreEpoch(runtime, {
      storeFormat: format,
      build,
      startupBusyTimeoutMs: 1,
      authorizeMint: ({ incumbent, incumbentEpochKey }) =>
        incumbent === null ? null : retirementMintDisposition('unopenable', incumbentEpochKey),
    });
    successor.db.close();

    expect(successor.store.epoch).toBe('2');
    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
    expect(listStoreEpochs(runtime)).toContainEqual(expect.objectContaining({ epoch: '1', role: 'protected' }));
  });

  it('should publish past a superseded epoch its opener keeps holding, list it as pending, and protect it once released', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-superseded-protection-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const settled = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
    settled.db.close();
    encodeResolvedStoreEpoch(runtime, settled.store);
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    chmodSync(join(epochDirectory(dbDir, '1'), 'store.db'), 0o000);
    const opener = createSharedFileLockSync(join(epochDirectory(dbDir, '1'), '.lock'));
    let successor: ReturnType<typeof settleStoreEpoch>;
    try {
      successor = settleStoreEpoch(runtime, {
        storeFormat: format,
        build,
        startupBusyTimeoutMs: 1,
        authorizeMint: ({ incumbent, incumbentEpochKey }) =>
          incumbent === null ? null : retirementMintDisposition('unopenable', incumbentEpochKey),
      });
      successor.db.close();

      expect(successor.store.epoch).toBe('2');
      expect(existsSync(epochDirectory(dbDir, '1'))).toBe(true);
      expect(listStoreEpochs(runtime)).toContainEqual(
        expect.objectContaining({ epoch: '1', protectionPending: expect.stringContaining('opener') as unknown }),
      );
    } finally {
      opener();
    }

    await sweepStoreEpochsPostReady(runtime, successor.store);

    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
    const listed = listStoreEpochs(runtime).find((entry) => entry.epoch === '1');
    expect(listed).toMatchObject({ role: 'protected' });
    expect(listed?.protectionPending).toBeUndefined();
  });

  it('preserves additive pending-protection fields when another mint retries the held epoch', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-pending-protection-additive-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const initial = settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint });
    initial.db.close();
    encodeResolvedStoreEpoch(runtime, initial.store);
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    chmodSync(epochPath(dbDir, '1'), 0o000);
    const opener = createSharedFileLockSync(join(epochDirectory(dbDir, '1'), '.lock'));
    try {
      const mint = () => {
        const settled = settleStoreEpoch(runtime, {
          storeFormat: format,
          build,
          startupBusyTimeoutMs: 1,
          authorizeMint: ({ incumbent, incumbentEpochKey }) =>
            incumbent === null ? null : retirementMintDisposition('unopenable', incumbentEpochKey),
        });
        settled.db.close();
        return settled.store.epoch;
      };
      expect(mint()).toBe('2');
      const pendingDir = join(runtime.paths.coral.generation.dataRoot, 'store-epoch-protection-pending.v1');
      const pendingPath = join(pendingDir, `${sha256Hex(epochDirectory(dbDir, '1'))}.json`);
      const pending = JSON.parse(readFileSync(pendingPath, 'utf-8')) as Record<string, unknown>;
      writeFileSync(pendingPath, `${JSON.stringify({ ...pending, futureRetry: 'keep' })}\n`);
      chmodSync(epochPath(dbDir, '2'), 0o000);
      expect(mint()).toBe('3');
      expect(JSON.parse(readFileSync(pendingPath, 'utf-8'))).toMatchObject({ futureRetry: 'keep' });
      expect(listStoreEpochs(runtime).find((entry) => entry.epoch === '1')).toMatchObject({
        protectionPending: expect.any(String),
      });
    } finally {
      opener();
    }
  });

  it('reports an unreadable pending marker and retries its proven epoch without deleting the marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-pending-protection-unreadable-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    const initial = settleStoreEpoch(runtime, {
      storeFormat: format,
      build,
      authorizeMint: authorizeFixtureStoreMint,
    });
    initial.db.close();
    encodeResolvedStoreEpoch(runtime, initial.store);
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    chmodSync(epochPath(dbDir, '1'), 0o000);
    const opener = createSharedFileLockSync(join(epochDirectory(dbDir, '1'), '.lock'));
    let successor: ReturnType<typeof settleStoreEpoch>;
    try {
      successor = settleStoreEpoch(runtime, {
        storeFormat: format,
        build,
        startupBusyTimeoutMs: 1,
        authorizeMint: ({ incumbent, incumbentEpochKey }) =>
          incumbent === null ? null : retirementMintDisposition('unopenable', incumbentEpochKey),
      });
      successor.db.close();
      const pendingDir = join(runtime.paths.coral.generation.dataRoot, 'store-epoch-protection-pending.v1');
      const pending = readdirSync(pendingDir).at(0);
      if (pending === undefined) throw new Error('Deferred protection was not recorded.');
      writeFileSync(join(pendingDir, pending), '{');
      expect(listStoreEpochs(runtime).find((entry) => entry.epoch === '1')?.protectionUnreadable).toBe(true);
      const status = withSupersededEpochClosures(runtime, {} as BackendStatusFull);
      expect(status.supersededEpochs).toMatchObject({
        kind: 'observed',
        epochs: expect.arrayContaining([expect.objectContaining({ epoch: '1', protectionUnreadable: true })]),
      });
    } finally {
      opener();
    }

    await sweepStoreEpochsPostReady(runtime, successor.store);

    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
    expect(listStoreEpochs(runtime)).toContainEqual(expect.objectContaining({ epoch: '1', role: 'protected' }));
    expect(
      readFileSync(
        join(
          runtime.paths.coral.generation.dataRoot,
          'store-epoch-protection-pending.v1',
          `${sha256Hex(epochDirectory(dbDir, '1'))}.json`,
        ),
        'utf-8',
      ),
    ).toBe('{');
  });

  it('preserves an unsupported pending-protection generation during a sweep', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-pending-protection-generation-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true });
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    for (const epoch of ['1', '2']) {
      const directory = epochDirectory(dbDir, epoch);
      mkdirSync(directory, { recursive: true });
      writeFileSync(storeEpochLockPath(dbDir, epoch), '');
      openTestStoreDatabase({ path: epochPath(dbDir, epoch), storage: runtime.storage, storeFormat: format }).close();
      writeFileSync(
        join(directory, 'epoch.json'),
        JSON.stringify({
          supersedes: null,
          classification: { kind: 'absent' },
          build,
          publishedAt: '2026-09-25T00:00:00.000Z',
        }),
      );
    }
    const pendingDir = join(runtime.paths.coral.generation.dataRoot, 'store-epoch-protection-pending.v1');
    const pendingPath = join(pendingDir, `${sha256Hex(epochDirectory(dbDir, '1'))}.json`);
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      pendingPath,
      JSON.stringify({
        version: 'v2',
        storeRoot: dbDir,
        epoch: '1',
        reason: 'newer owner',
        recordedAt: '2026-09-25T00:00:00.000Z',
        futureReleaseCondition: 'controller-receipt-v2',
      }),
    );

    await sweepStoreEpochsPostReady(runtime, { storeRoot: dbDir, epoch: '2', path: epochPath(dbDir, '2') });

    expect(listStoreEpochs(runtime)).toContainEqual(expect.objectContaining({ epoch: '1', role: 'protected' }));
    expect(JSON.parse(readFileSync(pendingPath, 'utf8'))).toMatchObject({
      version: 'v2',
      futureReleaseCondition: 'controller-receipt-v2',
    });
  });

  it('reports an unreadable marker directory and retries protection for proven older epochs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-pending-protection-directory-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true });
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    for (const epoch of ['1', '2']) {
      const directory = epochDirectory(dbDir, epoch);
      mkdirSync(directory, { recursive: true });
      writeFileSync(storeEpochLockPath(dbDir, epoch), '');
      openTestStoreDatabase({ path: epochPath(dbDir, epoch), storage: runtime.storage, storeFormat: format }).close();
      writeFileSync(
        join(directory, 'epoch.json'),
        JSON.stringify({
          supersedes: null,
          classification: { kind: 'absent' },
          build,
          publishedAt: '2026-09-25T00:00:00.000Z',
        }),
      );
    }
    const pendingDir = join(runtime.paths.coral.generation.dataRoot, 'store-epoch-protection-pending.v1');
    const readdir = runtime.storage.readdirSync;
    vi.spyOn(runtime.storage, 'readdirSync').mockImplementation((path, options) => {
      if (path === pendingDir) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return readdir(path, options);
    });

    expect(listStoreEpochs(runtime).find((entry) => entry.epoch === '1')?.protectionUnreadable).toBe(true);
    await sweepStoreEpochsPostReady(runtime, { storeRoot: dbDir, epoch: '2', path: epochPath(dbDir, '2') });
    expect(existsSync(epochDirectory(dbDir, '1'))).toBe(false);
  });

  it('retains a marker that becomes unreadable while protection is in progress', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-pending-protection-replaced-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    mkdirSync(runtime.paths.coral.store.dbDir, { recursive: true });
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    for (const epoch of ['1', '2']) {
      const directory = epochDirectory(dbDir, epoch);
      mkdirSync(directory, { recursive: true });
      writeFileSync(storeEpochLockPath(dbDir, epoch), '');
      openTestStoreDatabase({ path: epochPath(dbDir, epoch), storage: runtime.storage, storeFormat: format }).close();
      writeFileSync(
        join(directory, 'epoch.json'),
        JSON.stringify({
          supersedes: null,
          classification: { kind: 'absent' },
          build,
          publishedAt: '2026-09-25T00:00:00.000Z',
        }),
      );
    }
    const pendingDir = join(runtime.paths.coral.generation.dataRoot, 'store-epoch-protection-pending.v1');
    const pendingPath = join(pendingDir, `${sha256Hex(epochDirectory(dbDir, '1'))}.json`);
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      pendingPath,
      JSON.stringify({
        version: 'v1',
        storeRoot: dbDir,
        epoch: '1',
        reason: 'held',
        recordedAt: '2026-09-25T00:00:00.000Z',
      }),
    );
    const protect = epochProtection.protectStoreEpoch;
    vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation((...args) => {
      if (args[1].epoch === '1') writeFileSync(pendingPath, '{');
      return protect(...args);
    });

    await sweepStoreEpochsPostReady(runtime, { storeRoot: dbDir, epoch: '2', path: epochPath(dbDir, '2') });

    expect(readFileSync(pendingPath, 'utf-8')).toBe('{');
    expect(listStoreEpochs(runtime)).toContainEqual(expect.objectContaining({ protectionUnreadable: true }));
  });

  it('should refuse publication when a held epoch cannot be recorded for later protection', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-superseded-protection-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint }).db.close();
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    const held = vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation(() => {
      throw new epochProtection.StoreEpochOpenerHeldError('held');
    });
    const write = runtime.storage.writeAtomicDurableSync;
    vi.spyOn(runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, ...args) =>
      path.includes('store-epoch-protection-pending.v1') ? false : write(path, ...args),
    );

    expect(() => discardCurrentStoreEpoch(runtime, { storeFormat: format, build })).toThrow();
    expect(existsSync(epochDirectory(dbDir, '2'))).toBe(false);
    held.mockRestore();
  });

  it('should refuse publication when the first pending directory cannot be synced', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-superseded-protection-'));
    roots.push(root);
    const runtime = createRealRuntime('prod', { baseDir: root });
    settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint }).db.close();
    const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
    const held = vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation(() => {
      throw new epochProtection.StoreEpochOpenerHeldError('held');
    });
    const sync = runtime.storage.syncDirectoryDurableSync;
    vi.spyOn(runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) =>
      path === runtime.paths.coral.generation.dataRoot ? false : sync(path),
    );

    expect(() => discardCurrentStoreEpoch(runtime, { storeFormat: format, build })).toThrow();
    expect(existsSync(epochDirectory(dbDir, '2'))).toBe(false);
    held.mockRestore();
  });

  describe('an epoch awaiting protection when a later mint meets it', () => {
    const protect = epochProtection.protectStoreEpoch;

    /** Epoch 1 stays at its canonical address, recorded as pending, behind a current epoch 2. */
    function pendingBehindCurrent(): Readonly<{ runtime: ReturnType<typeof createRealRuntime>; dbDir: string }> {
      const root = mkdtempSync(join(tmpdir(), 'coral-superseded-protection-'));
      roots.push(root);
      const runtime = createRealRuntime('prod', { baseDir: root });
      settleStoreEpoch(runtime, { storeFormat: format, build, authorizeMint: authorizeFixtureStoreMint }).db.close();
      const dbDir = realpathSync(runtime.paths.coral.store.dbDir);
      const held = vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation((_runtime, epoch) => {
        throw new epochProtection.StoreEpochOpenerHeldError(`lineage:${epoch.epoch}`);
      });
      discardCurrentStoreEpoch(runtime, { storeFormat: format, build }).db.close();
      held.mockRestore();
      expect(listStoreEpochs(runtime)).toContainEqual(
        expect.objectContaining({ epoch: '1', protectionPending: expect.any(String) as unknown }),
      );
      return { runtime, dbDir };
    }

    it('should publish past it when another process protected it after this mint observed it', () => {
      const { runtime, dbDir } = pendingBehindCurrent();
      vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation((...args) => {
        const [, epoch] = args;
        // The incumbent's pending-protection retry moves the epoch first.
        if (epoch.epoch === '1' && existsSync(epochDirectory(dbDir, '1'))) protect(...args);
        return protect(...args);
      });

      const minted = discardCurrentStoreEpoch(runtime, { storeFormat: format, build });
      minted.db.close();

      expect(minted.store.epoch).toBe('3');
      expect(listStoreEpochs(runtime).find((entry) => entry.epoch === '1')).toMatchObject({ role: 'protected' });
    });

    it('should publish past it when its protection keeps failing for another reason', () => {
      const { runtime } = pendingBehindCurrent();
      vi.spyOn(epochProtection, 'protectStoreEpoch').mockImplementation((...args) => {
        if (args[1].epoch === '1') throw new Error('lineage marker is unreadable');
        return protect(...args);
      });

      const minted = discardCurrentStoreEpoch(runtime, { storeFormat: format, build });
      minted.db.close();

      expect(minted.store.epoch).toBe('3');
      expect(listStoreEpochs(runtime)).toContainEqual(
        expect.objectContaining({ epoch: '1', protectionPending: 'lineage marker is unreadable' }),
      );
    });
  });
});

it.each(['', 'relative', '/tmp/../store'])('retains an invalid pending-protection root: %s', (storeRoot) => {
  const root = mkdtempSync(join(tmpdir(), 'coral-invalid-protection-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const canonicalRoot = runtime.paths.coral.store.dbDir;
  expect(recordPendingProtection(runtime, canonicalRoot, '1', 'busy').kind).toBe('recorded');
  const directory = join(runtime.paths.coral.generation.dataRoot, 'store-epoch-protection-pending.v1');
  const name = readdirSync(directory)[0];
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), storeRoot }));
  expect(readPendingProtections(runtime)).toMatchObject({ records: [], unreadableNames: [name] });
});
