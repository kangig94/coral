import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { openWritableStoreDatabase, SuccessionWriterParkedError, type Database } from '#src/store/db.js';
import { resolveGenerationBoundaryPaths } from '#src/store/generation-mutation-coordination.js';
import {
  advanceSuccessionWriterGeneration,
  fenceCorpusStorage,
  handbackSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
  recoverSuccessionWriterGeneration,
  readSuccessionWriterGeneration,
  recordSuccessionServing,
  generationForLegacySuccessor,
  SuccessionServingCommittedError,
  SuccessionWriterGenerationExhaustedError,
} from '#src/store/succession-writer-generation.js';
import { recoverDamagedStartupWriter } from '#src/coordinator/succession/writer-recovery.js';
import { settleStoreEpoch } from '#src/store/epoch/index.js';
import { authorizeFixtureStoreMint } from '#tests/helpers/store-db.js';
import { reclaimIncumbentWriter } from '#src/coordinator/succession/commit/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

const temporaryDirectories: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-succession-writer-'));
  temporaryDirectories.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const store = { storeRoot: join(root, 'epochs'), epoch: '1' };
  const dbPath = join(root, 'store.db');
  const open = (): Database => {
    const writerEntitlement = joinSuccessionWriterGeneration(runtime, store);
    const decision = openWritableStoreDatabase({
      path: dbPath,
      storage: runtime.storage,
      storeFormat: currentCoralStoreFormat(),
      flavor: runtime.flavor,
      writerEntitlement,
    });
    if (decision.kind !== 'opened') throw new Error('Expected compatible test store.');
    return decision.db;
  };
  return { root, runtime, store, open };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('succession writer generation', () => {
  it('recovers above all observable generations and fences stale Journal and Corpus writers', () => {
    const { root, runtime, store, open } = fixture();
    const writer = joinSuccessionWriterGeneration(runtime, store);
    const corpus = fenceCorpusStorage(runtime.storage, writer);
    const db = open();
    db.exec('CREATE TABLE recovered_writer (value TEXT)');
    const path = join(resolveGenerationBoundaryPaths(runtime).coordinationRoot, 'succession-writer-generation.v1.json');
    const higherGeneration = runtime.time.now() + 100_000;
    writeFileSync(path, `{"generation":${higherGeneration},`);
    expect(() => writer.withWriteTurn(() => undefined)).toThrow(/Corrupt/u);
    expect(() => joinSuccessionWriterGeneration(runtime, store)).toThrow(/Corrupt/u);
    expect(readFileSync(path, 'utf8')).toContain(String(higherGeneration));
    const serving = {
      attemptId: 'proven-served',
      epochKey: JSON.stringify({ ...store, path: join(root, 'store.db') }),
      successorInstanceId: 'previous-successor',
      controlGeneration: higherGeneration - 1,
      recordedAt: new Date(runtime.time.now()).toISOString(),
    };
    recoverSuccessionWriterGeneration(runtime, () => ({
      store,
      generations: [higherGeneration - 1],
      servings: [serving],
      release() {},
    }));
    const recovered = joinSuccessionWriterGeneration(runtime, store);
    expect(recovered.generation.generation).toBe(higherGeneration + 1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ priorServings: [serving] });
    expect(() => db.prepare('INSERT INTO recovered_writer VALUES (?)').run('stale')).toThrow(/lost its entitlement/u);
    expect(() => corpus.writeFileSync(join(root, 'stale.txt'), 'stale')).toThrow(/lost its entitlement/u);
    expect(existsSync(join(root, 'stale.txt'))).toBe(false);
    expect(recovered.withWriteTurn(() => 'current')).toBe('current');
    expect(advanceSuccessionWriterGeneration(runtime, recovered.generation, store).generation).toBe(
      higherGeneration + 2,
    );
    db.close();
  });

  it('refuses a stale write after BEGIN IMMEDIATE when generation advances first', () => {
    const { root, runtime, store, open } = fixture();
    const oldWriter = joinSuccessionWriterGeneration(runtime, store);
    const staleCorpus = fenceCorpusStorage(runtime.storage, oldWriter);
    const db = open();
    try {
      db.exec('CREATE TABLE succession_test (value TEXT NOT NULL)');
      const next = advanceSuccessionWriterGeneration(runtime, oldWriter.generation, store);

      expect(() => db.exec('BEGIN IMMEDIATE')).toThrow(/lost its entitlement/u);
      expect(db.isTransaction).toBe(false);
      expect(() => db.prepare('INSERT INTO succession_test (value) VALUES (?)').run('stale')).toThrow(
        /lost its entitlement/u,
      );
      expect(db.prepare<[], { total: number }>('SELECT count(*) AS total FROM succession_test').get()?.total).toBe(0);
      const corpusPath = join(root, 'stale-corpus.txt');
      expect(() => staleCorpus.writeFileSync(corpusPath, 'stale')).toThrow(/lost its entitlement/u);
      expect(existsSync(corpusPath)).toBe(false);
      expect(next.generation).toBe(oldWriter.generation.generation + 1);
    } finally {
      db.close();
    }
  });

  it('refuses a parked handle with a typed error that settles only on reclaim, and a closed one with none', async () => {
    const { runtime, store, open } = fixture();
    const writer = joinSuccessionWriterGeneration(runtime, store);
    const db = open();
    writer.park();
    let refusal: unknown;
    try {
      db.prepare('SELECT 1');
    } catch (error: unknown) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SuccessionWriterParkedError);
    if (!(refusal instanceof SuccessionWriterParkedError)) return;
    let reclaimed = false;
    void refusal.unparked.then(() => {
      reclaimed = true;
    });
    await Promise.resolve();
    expect(reclaimed).toBe(false);

    writer.unpark();
    await refusal.unparked;
    expect(db.prepare<[], { one: number }>('SELECT 1 AS one').get()?.one).toBe(1);
    db.close();
    expect(() => db.prepare('SELECT 1')).toThrow(/closed/u);
    expect(() => db.prepare('SELECT 1')).not.toThrow(SuccessionWriterParkedError);
  });

  it('rebinds the incumbent store handle after an unserved successor generation', () => {
    const { runtime, store, open } = fixture();
    const incumbent = joinSuccessionWriterGeneration(runtime, store);
    const db = open();
    db.exec('CREATE TABLE succession_handback (value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO succession_handback (value) VALUES (?)');
    incumbent.park();
    const failed = advanceSuccessionWriterGeneration(runtime, incumbent.generation, store);

    const recovered = handbackSuccessionWriterGeneration(runtime, failed, store);
    expect(recovered.generation).toBe(failed.generation + 1);
    expect(incumbent.generation).toEqual(recovered);
    incumbent.unpark();
    insert.run('reclaimed');
    expect(db.prepare<[], { value: string }>('SELECT value FROM succession_handback').get()?.value).toBe('reclaimed');
    db.close();
  });
});

it('reclaims Journal and Corpus writers after successive serving upgrades and fences a newer successor', async () => {
  const { root, runtime, store, open } = fixture();
  let writer = joinSuccessionWriterGeneration(runtime, store);
  for (const attemptId of ['upgrade-A', 'upgrade-B']) {
    const stale = writer;
    const generation = advanceSuccessionWriterGeneration(runtime, writer.generation, store);
    writer = joinSuccessionWriterGeneration(runtime, store);
    recordSuccessionServing(runtime, generation, {
      attemptId,
      successorInstanceId: 'incumbent',
      epochKey: JSON.stringify({ ...store, path: join(store.storeRoot, 'epoch-1', 'store.db') }),
      controlGeneration: generation.generation,
      recordedAt: new Date(runtime.time.now()).toISOString(),
    });
    expect(() => stale.withWriteTurn(() => undefined)).toThrow(/lost its entitlement/u);
    const db = open();
    const corpus = fenceCorpusStorage(runtime.storage, writer);
    db.exec('CREATE TABLE IF NOT EXISTS reclaimed_writer (value TEXT)');
    writer.park();
    const reclaimed = await reclaimIncumbentWriter({
      runtime,
      writer,
      storeDb: db,
      incumbentInstanceId: 'incumbent',
      deadlineMs: 2_000,
      reclaimKbDaemonWriter: async () => writer.unpark(),
      reportReclaimFailure: () => {},
    });
    try {
      expect(reclaimed.kind).toBe('reclaimed');
      db.prepare('INSERT INTO reclaimed_writer VALUES (?)').run(attemptId);
      corpus.writeFileSync(join(root, 'reclaimed.txt'), attemptId);
      expect(readFileSync(join(root, 'reclaimed.txt'), 'utf8')).toBe(attemptId);
    } finally {
      if (reclaimed.kind === 'reclaimed') reclaimed.providerOperationAdmission.close();
      db.close();
    }
  }
  writer.park();
  const successor = advanceSuccessionWriterGeneration(runtime, writer.generation, store);
  recordSuccessionServing(runtime, successor, {
    attemptId: 'newer-successor',
    successorInstanceId: 'successor',
    epochKey: JSON.stringify({ ...store, path: join(store.storeRoot, 'epoch-1', 'store.db') }),
    controlGeneration: successor.generation,
    recordedAt: new Date(runtime.time.now()).toISOString(),
  });
  expect(() => writer.unpark()).toThrow(/cannot unpark after advance/u);
  expect(() => writer.withWriteTurn(() => undefined)).toThrow(/parked/u);
  expect(() => handbackSuccessionWriterGeneration(runtime, successor, store)).toThrow(SuccessionServingCommittedError);
});

it.each([
  { storeRoot: '', epoch: '1' },
  { storeRoot: 'relative', epoch: '1' },
  { storeRoot: '/tmp/../epochs', epoch: '1' },
  { storeRoot: '/epochs', epoch: '' },
  { storeRoot: '/epochs', epoch: '0' },
  { storeRoot: '/epochs', epoch: '01' },
  { storeRoot: '/epochs', epoch: '../1' },
  { storeRoot: '/epochs', epoch: ' 1' },
  { refusedAttemptIds: [''] },
  { refusedAttemptIds: ['  '] },
])('recovers semantically corrupt writer identity: %j', (damage) => {
  const { runtime, store } = fixture();
  joinSuccessionWriterGeneration(runtime, store);
  const path = join(resolveGenerationBoundaryPaths(runtime).coordinationRoot, 'succession-writer-generation.v1.json');
  writeFileSync(path, JSON.stringify({ generation: 1, ...store, ...damage, additiveField: 'preserved' }));
  expect(readSuccessionWriterGeneration(runtime).kind).toBe('corrupt');
  recoverSuccessionWriterGeneration(runtime, () => ({ store, generations: [1], servings: [], release() {} }));
  expect(readSuccessionWriterGeneration(runtime)).toMatchObject({
    kind: 'recorded',
    record: { ...store, additiveField: 'preserved' },
  });
  expect(joinSuccessionWriterGeneration(runtime, store).withWriteTurn(() => 'recovered')).toBe('recovered');
});

it.each(['advance', 'handback', 'legacy'] as const)(
  'refuses %s exhaustion without changing the durable record',
  (operation) => {
    const { runtime, store } = fixture();
    joinSuccessionWriterGeneration(runtime, store);
    const path = join(resolveGenerationBoundaryPaths(runtime).coordinationRoot, 'succession-writer-generation.v1.json');
    const expected = { generation: Number.MAX_SAFE_INTEGER, ...store };
    writeFileSync(path, JSON.stringify(expected));
    if (operation === 'legacy')
      recordSuccessionServing(runtime, expected, {
        attemptId: 'previous',
        successorInstanceId: 'incumbent',
        epochKey: JSON.stringify({ ...store, path: join(store.storeRoot, 'epoch-1', 'store.db') }),
        controlGeneration: expected.generation,
        recordedAt: new Date(runtime.time.now()).toISOString(),
      });
    const before = readFileSync(path, 'utf8');
    const advance = () =>
      operation === 'advance'
        ? advanceSuccessionWriterGeneration(runtime, expected, store)
        : operation === 'handback'
          ? handbackSuccessionWriterGeneration(runtime, expected, store)
          : generationForLegacySuccessor(runtime, expected, 'next', 'previous');
    expect(advance).toThrow(SuccessionWriterGenerationExhaustedError);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readSuccessionWriterGeneration(runtime).kind).toBe('recorded');
  },
);

it('advances the final safe generation and preserves additive durable fields', () => {
  const { runtime, store } = fixture();
  joinSuccessionWriterGeneration(runtime, store);
  const path = join(resolveGenerationBoundaryPaths(runtime).coordinationRoot, 'succession-writer-generation.v1.json');
  const expected = { generation: Number.MAX_SAFE_INTEGER - 1, ...store };
  writeFileSync(path, JSON.stringify({ ...expected, additiveField: 'preserved' }));
  expect(advanceSuccessionWriterGeneration(runtime, expected, store).generation).toBe(Number.MAX_SAFE_INTEGER);
  expect(readSuccessionWriterGeneration(runtime)).toMatchObject({
    kind: 'recorded',
    record: { additiveField: 'preserved' },
  });
});

it('runs damaged-writer startup recovery for a semantically invalid durable identity', () => {
  const { runtime } = fixture();
  const format = currentCoralStoreFormat();
  const settled = settleStoreEpoch(runtime, {
    storeFormat: format,
    authorizeMint: authorizeFixtureStoreMint,
    build: {
      version: format.productVersion,
      buildSetId: '00000000-0000-4000-8000-000000000001',
      flavor: 'prod',
      storeFormatFingerprint: format.fingerprint,
      bundleHash: '0123456789abcdef',
      cliBundleHash: '0123456789abcdef',
      claudeAppserverBundleHash: '0123456789abcdef',
      durableWrapperBundleHash: '0123456789abcdef',
    },
  });
  settled.db.close();
  const path = join(resolveGenerationBoundaryPaths(runtime).coordinationRoot, 'succession-writer-generation.v1.json');
  writeFileSync(path, JSON.stringify({ generation: 1, storeRoot: '', epoch: '' }));
  recoverDamagedStartupWriter(runtime);
  expect(readSuccessionWriterGeneration(runtime)).toMatchObject({
    kind: 'recorded',
    record: { storeRoot: settled.store.storeRoot, epoch: settled.store.epoch },
  });
  expect(joinSuccessionWriterGeneration(runtime, settled.store).withWriteTurn(() => 'started')).toBe('started');
});
