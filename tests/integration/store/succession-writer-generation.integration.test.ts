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
} from '#src/store/succession-writer-generation.js';
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
