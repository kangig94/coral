import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  observeSuccessionServing,
  recordSuccessionServing,
  refuseSuccessionAttempt,
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
  it('allows coordinator and KB daemon writable handles and Corpus writes before takeover', () => {
    const { root, runtime, store, open } = fixture();
    const coordinator = open();
    const daemon = open();
    try {
      coordinator.exec('CREATE TABLE succession_test (value TEXT NOT NULL)');
      coordinator.exec('BEGIN IMMEDIATE');
      coordinator.prepare('INSERT INTO succession_test (value) VALUES (?)').run('coordinator');
      coordinator.exec('COMMIT');
      daemon.prepare('INSERT INTO succession_test (value) VALUES (?)').run('daemon');
      const corpusStorage = fenceCorpusStorage(runtime.storage, joinSuccessionWriterGeneration(runtime, store));
      const corpusPath = join(root, 'corpus.txt');
      corpusStorage.writeFileSync(corpusPath, 'daemon', { mode: 0o600 });

      expect(
        coordinator.prepare<[], { total: number }>('SELECT count(*) AS total FROM succession_test').get()?.total,
      ).toBe(2);
      expect(readFileSync(corpusPath, 'utf-8')).toBe('daemon');
    } finally {
      daemon.close();
      coordinator.close();
    }
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

  it('unparks only while the original generation remains current', () => {
    const { runtime, store, open } = fixture();
    const writer = joinSuccessionWriterGeneration(runtime, store);
    const otherHandle = joinSuccessionWriterGeneration(runtime, store);
    const db = open();
    db.exec('CREATE TABLE succession_reclaim (value TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO succession_reclaim (value) VALUES (?)');
    writer.park();
    expect(() => db.prepare('SELECT 1')).toThrow();
    expect(() => writer.withWriteTurn(() => undefined)).toThrow(/parked/u);
    expect(() => otherHandle.withWriteTurn(() => undefined)).toThrow(/parked/u);
    writer.unpark();
    expect(otherHandle.withWriteTurn(() => 'resumed')).toBe('resumed');
    insert.run('same-process');
    expect(db.prepare<[], { value: string }>('SELECT value FROM succession_reclaim').get()?.value).toBe('same-process');
    const reopened = open();
    reopened.close();
    writer.park();
    advanceSuccessionWriterGeneration(runtime, writer.generation, store);
    expect(() => writer.unpark()).toThrow(/cannot unpark/u);
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
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reclaimed).toBe(false);

    writer.unpark();
    await refusal.unparked;
    expect(db.prepare<[], { one: number }>('SELECT 1 AS one').get()?.one).toBe(1);
    db.close();
    expect(() => db.prepare('SELECT 1')).toThrow(/closed/u);
    expect(() => db.prepare('SELECT 1')).not.toThrow(SuccessionWriterParkedError);
  });

  it('recovers after a parked process crashes and hands back monotonically', () => {
    const { runtime, store } = fixture();
    const vanishedWriter = joinSuccessionWriterGeneration(runtime, store);
    vanishedWriter.park();
    const guard = join(resolveGenerationBoundaryPaths(runtime).coordinationRoot, 'succession-writer-guard.db');
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN; SELECT count(*) FROM sqlite_schema'); db.exec('ROLLBACK'); db.close(); process.kill(process.pid, 'SIGKILL');",
        guard,
      ],
      { encoding: 'utf-8' },
    );
    expect(child.signal).toBe('SIGKILL');

    const successor = advanceSuccessionWriterGeneration(runtime, vanishedWriter.generation, store);
    const successorWriter = joinSuccessionWriterGeneration(runtime, store);
    expect(successorWriter.generation).toEqual(successor);
    successorWriter.park();

    const incumbent = handbackSuccessionWriterGeneration(runtime, successor, store);
    expect(incumbent.generation).toBe(successor.generation + 1);
    expect(joinSuccessionWriterGeneration(runtime, store).generation).toEqual(incumbent);
    expect(() => successorWriter.unpark()).toThrow(/cannot unpark/u);
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
    expect(incumbent.generation).toEqual(recovered);
    incumbent.unpark();
    insert.run('reclaimed');
    expect(db.prepare<[], { value: string }>('SELECT value FROM succession_handback').get()?.value).toBe('reclaimed');
    db.close();
  });

  it('hands back monotonically when the incumbent store is named by its own older generation', () => {
    const { runtime, store } = fixture();
    const incumbent = joinSuccessionWriterGeneration(runtime, store);
    incumbent.park();
    const failed = advanceSuccessionWriterGeneration(runtime, incumbent.generation, store);

    const recovered = handbackSuccessionWriterGeneration(runtime, failed, incumbent.generation);
    expect(recovered.generation).toBe(failed.generation + 1);
    expect(incumbent.generation).toEqual(recovered);
  });

  it('commits serving once against the current generation and full epoch key', () => {
    const { runtime, store } = fixture();
    const incumbent = joinSuccessionWriterGeneration(runtime, store);
    incumbent.park();
    const successor = advanceSuccessionWriterGeneration(runtime, incumbent.generation, store);
    const serving = {
      attemptId: 'attempt-1',
      epochKey: JSON.stringify({ ...store, path: join(store.storeRoot, 'epoch-1') }),
      successorInstanceId: 'successor-1',
      controlGeneration: successor.generation,
      recordedAt: new Date().toISOString(),
    };

    expect(recordSuccessionServing(runtime, successor, serving)).toEqual(serving);
    expect(recordSuccessionServing(runtime, successor, serving)).toEqual(serving);
    expect(observeSuccessionServing(runtime, 'attempt-1')).toEqual(serving);
    expect(observeSuccessionServing(runtime, 'another-attempt')).toBeNull();
    expect(() => recordSuccessionServing(runtime, successor, { ...serving, attemptId: 'attempt-2' })).toThrow(
      /already serves another attempt/u,
    );
    expect(() => recordSuccessionServing(runtime, successor, { ...serving, epochKey: '1' })).toThrow(
      /current full epoch key/u,
    );
    expect(() => recordSuccessionServing(runtime, incumbent.generation, serving)).toThrow(/current writer generation/u);
    expect(() => handbackSuccessionWriterGeneration(runtime, successor, store)).toThrow(/serving was committed/u);
  });

  it('fences a refused attempt out of the generation, but yields to one that already serves', () => {
    const { runtime, store } = fixture();
    const incumbent = joinSuccessionWriterGeneration(runtime, store);
    incumbent.park();
    const servingOf = (attemptId: string, generation: number) => ({
      attemptId,
      epochKey: JSON.stringify({ ...store, path: join(store.storeRoot, 'epoch-1') }),
      successorInstanceId: 'successor-1',
      controlGeneration: generation,
      recordedAt: new Date().toISOString(),
    });

    expect(refuseSuccessionAttempt(runtime, 'refused-early')).toEqual({ kind: 'refused' });
    expect(() => advanceSuccessionWriterGeneration(runtime, incumbent.generation, store, 'refused-early')).toThrow(
      /was refused/u,
    );
    const advanced = advanceSuccessionWriterGeneration(runtime, incumbent.generation, store, 'refused-late');
    expect(refuseSuccessionAttempt(runtime, 'refused-late')).toEqual({ kind: 'refused' });
    expect(() => recordSuccessionServing(runtime, advanced, servingOf('refused-late', advanced.generation))).toThrow(
      /was refused/u,
    );
    expect(observeSuccessionServing(runtime, 'refused-late')).toBeNull();

    const handedBack = handbackSuccessionWriterGeneration(runtime, advanced, store);
    const successor = advanceSuccessionWriterGeneration(runtime, handedBack, store, 'serving');
    const serving = recordSuccessionServing(runtime, successor, servingOf('serving', successor.generation));
    expect(refuseSuccessionAttempt(runtime, 'serving')).toEqual({ kind: 'serving', serving });
    expect(observeSuccessionServing(runtime, 'serving')).toEqual(serving);
  });
});
