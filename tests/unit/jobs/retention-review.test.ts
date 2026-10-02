import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneJobProgress } from '#src/jobs/progress-retention.js';
import { readExportJobState } from '#src/jobs/export-retention.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { encodeResolvedStoreEpoch } from '#src/store/epoch/observation.js';
import { protectStoreEpoch, protectedStoreEpochRoot } from '#src/store/epoch/protection.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { createRetentionFixture, RETENTION_CUTOFF } from '#tests/helpers/storage-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import type { Runtime } from '#src/runtime/ports.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
function fixture() {
  const f = createRetentionFixture();
  fixtures.push(f);
  f.setNow(1);
  return f;
}
function launch(f: ReturnType<typeof fixture>, id: string) {
  initTestJob(f.store, {
    jobId: id,
    sessionId: `session-${id}`,
    provider: 'codex',
    projectRoot: '/workspace',
    backendNamespace: 'test-ns',
  });
}
function finish(f: ReturnType<typeof fixture>, id: string) {
  commitJobTerminal(f.store, id, `session-${id}`, { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 });
}
function prune(f: ReturnType<typeof fixture>) {
  return pruneJobProgress({ db: f.db, readCtx: f.store, cutoff: RETENTION_CUTOFF, afterSeq: 0, budget: f.budget });
}

describe('retention round-one probes', () => {
  it.each(['direct', 'reason', 'terminal', 'unknown-nesting'])(
    'protects %s causal shapes with indexed transaction checks',
    async (shape) => {
      const f = fixture();
      launch(f, 'old');
      const seq = f.store.appendProgress('old', 'session-old', 'evidence');
      finish(f, 'old');
      const causeRef = { stream: { kind: 'job', id: 'old' }, seq };
      const bodies = {
        direct: { causeRef },
        reason: { reason: { causeRef } },
        terminal: { terminal: { outcome: { causeRef } } },
        'unknown-nesting': { future: { causeRef } },
      };
      f.db
        .prepare(
          "INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, 'future.event', 'workflow', 'reference', ?)",
        )
        .run(new Date(1).toISOString(), Buffer.from(JSON.stringify(bodies[shape as keyof typeof bodies])));
      await prune(f);
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(seq)).toBeDefined();
      const plans = [
        'causation_seq = 1',
        "CASE WHEN json_valid(body) THEN json_extract(body, '$.terminal.outcome.causeRef.seq') END = 1",
      ].map((predicate) => f.db.prepare(`EXPLAIN QUERY PLAN SELECT seq FROM events WHERE ${predicate} LIMIT 1`).all());
      expect(JSON.stringify(plans)).not.toContain('SCAN events');
    },
  );

  it('resumes inside an interrupted job without revisiting its retained progress prefix', async () => {
    const f = fixture();
    launch(f, 'large');
    for (let i = 0; i < 130; i += 1) f.store.appendProgress('large', 'session-large', `message ${i}`);
    finish(f, 'large');
    let checks = 0;
    f.budget.canContinue = () => ++checks < 10;
    expect(await prune(f)).toBeGreaterThan(0);
    const checkpoint = f.db.prepare("SELECT value FROM meta WHERE key = 'storage-retention.progress.v1'").get() as {
      value: string;
    };
    expect(JSON.parse(checkpoint.value).progressSeq).toBeGreaterThan(0);
    f.budget.canContinue = () => true;
    await prune(f);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
      n: 0,
    });
  });
  it.each(['causeRef', 'causation_seq'])(
    'rechecks a late %s reference in the deleting transaction',
    async (reference) => {
      const f = fixture();
      launch(f, 'old');
      launch(f, 'other');
      let target = 0;
      for (let i = 0; i < 1005; i += 1) target = f.store.appendProgress('old', 'session-old', `message ${i}`);
      finish(f, 'old');
      const pruning = prune(f);
      if (reference === 'causeRef') {
        commitJobTerminal(f.store, 'other', 'session-other', {
          content: 'failed',
          outcome: { kind: 'failed', causeRef: { stream: { kind: 'job', id: 'old' }, seq: target } },
          durationMs: 1,
        });
      } else {
        finish(f, 'other');
        f.db
          .prepare("UPDATE events SET causation_seq = ? WHERE stream_id = 'other' AND type = 'job.terminal.recorded'")
          .run(target);
      }
      await pruning;
      expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(target)).toBeDefined();
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'job.progress.emitted'").get()).toEqual({
        n: 1,
      });
    },
  );

  it('does no synchronous journal work with an exhausted budget', async () => {
    const f = fixture();
    const prepare = vi.spyOn(f.db, 'prepare');
    f.budget.canContinue = () => false;
    await prune(f);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('uses indexed export discovery for absent jobs', () => {
    const f = fixture();
    expect(readExportJobState(f.db, f.store, 'absent')).toEqual({ kind: 'absent' });
    const plan = f.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .all('absent');
    expect(JSON.stringify(plan)).not.toContain('SCAN events');
  });

  it('releases absent locations even after ordinary epoch registration without scanning certificates', () => {
    const f = fixture();
    mkdirSync(join(f.runtime.paths.coral.generation.dataRoot, 'job-locations.v1', 'epochs', 'known'), {
      recursive: true,
    });
    const scan = vi.spyOn(f.runtime.storage, 'readDirectoryBoundedSync');
    const locations = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    expect(locations.exportResultRetention('absent', 'active')).toBe('released');
    expect(scan).not.toHaveBeenCalled();
  });

  it.each(['published', 'missing'])(
    'keeps protected deletion tombstones with a %s address publication',
    (publication) => {
      const f = fixture();
      openSettledTestStoreDb(f.runtime).close();
      const epoch = {
        storeRoot: f.runtime.paths.coral.store.dbDir,
        epoch: '1',
        path: join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'),
      };
      const epochKey = encodeResolvedStoreEpoch(f.runtime, epoch);
      const address = protectStoreEpoch(f.runtime, epoch);
      renameSync(address.protectedPath, join(address.protectedPath, '..', '.reaping-epoch-1'));
      if (publication === 'missing')
        unlinkSync(
          join(
            protectedStoreEpochRoot(epoch.storeRoot),
            'addresses',
            `${Buffer.from(address.epochKey).toString('base64url')}.json`,
          ),
        );
      const locations = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
      locations.register('historical', epochKey, {
        projectRoot: '/workspace',
        workDir: '/workspace',
        jobKind: 'provider',
      });
      expect(locations.exportResultRetention('historical', 'active')).toBe('required');
    },
  );

  it('continues the terminal scan after a restart instead of repeating the first thousand', async () => {
    const f = fixture();
    launch(f, 'first');
    finish(f, 'first');
    const source = f.db.prepare("SELECT ts, body FROM events WHERE type = 'job.terminal.recorded'").get() as {
      ts: string;
      body: Uint8Array;
    };
    const insert = f.db.prepare(
      "INSERT INTO events(type, stream_kind, stream_id, ts, body) VALUES ('job.terminal.recorded', 'job', ?, ?, ?)",
    );
    for (let i = 0; i < 999; i += 1) insert.run(`prefix-${i}`, source.ts, source.body);
    launch(f, 'tail');
    const target = f.store.appendProgress('tail', 'session-tail', 'tail progress');
    finish(f, 'tail');
    await prune(f);
    await prune(f);
    expect(f.db.prepare('SELECT seq FROM events WHERE seq = ?').get(target)).toBeUndefined();
  });

  it('keeps an unobservable protected epoch even when its address publication is missing', () => {
    const f = fixture();
    openSettledTestStoreDb(f.runtime).close();
    const epoch = {
      storeRoot: f.runtime.paths.coral.store.dbDir,
      epoch: '1',
      path: join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'),
    };
    const epochKey = encodeResolvedStoreEpoch(f.runtime, epoch);
    const address = protectStoreEpoch(f.runtime, epoch);
    unlinkSync(
      join(
        protectedStoreEpochRoot(epoch.storeRoot),
        'addresses',
        `${Buffer.from(address.epochKey).toString('base64url')}.json`,
      ),
    );
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'historical');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'closure proof');
    utimesSync(path, 1, 1);
    const lstat = vi.fn(f.runtime.storage.lstatSync);
    lstat.mockImplementation((...args) => {
      if (args[0] === address.protectedPath)
        throw Object.assign(new Error('unobservable protected epoch'), { code: 'EACCES' });
      return f.runtime.storage.lstatSync(...args);
    });
    const runtime = {
      ...f.runtime,
      storage: { ...f.runtime.storage, lstatSync: lstat as unknown as Runtime['storage']['lstatSync'] },
    };
    const locations = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    locations.register('historical', epochKey, {
      projectRoot: '/workspace',
      workDir: '/workspace',
      jobKind: 'provider',
    });
    expect(locations.exportResultRetention('historical', 'another-active-epoch')).toBe('unknown');
    expect(existsSync(join(path, 'result.md'))).toBe(true);
  });
});
