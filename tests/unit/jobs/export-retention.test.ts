import { encodeResolvedStoreEpoch } from '#src/store/epoch/observation.js';
import { protectStoreEpoch, protectedStoreEpochRoot } from '#src/store/epoch/protection.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import type { Runtime } from '#src/runtime/ports.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pruneJobExports, readExportJobState, type ExportJobRetentionState } from '#src/jobs/export-retention.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRetentionFixture, RETENTION_CUTOFF, RETENTION_NOW } from '#tests/helpers/storage-retention.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';

const fixtures: ReturnType<typeof createRetentionFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function fixture() {
  const value = createRetentionFixture();
  fixtures.push(value);
  return value;
}
function exported(f: ReturnType<typeof fixture>, id: string): string {
  const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
  mkdirSync(join(path, 'provider-artifacts'), { recursive: true });
  writeFileSync(join(path, 'result.md'), 'durable result');
  writeFileSync(join(path, 'provider-artifacts', 'original.jsonl'), 'provider session');
  return path;
}
async function prune(
  f: ReturnType<typeof fixture>,
  states: Record<string, ExportJobRetentionState>,
  holds: Record<string, 'released' | 'required' | 'unknown'> = {},
) {
  return pruneJobExports({
    db: f.db,
    runtime: f.runtime,
    cutoff: RETENTION_CUTOFF,
    afterId: '',
    budget: f.budget,
    jobState: (id) => states[id] ?? { kind: 'absent' },
    resultHold: (id) => holds[id] ?? 'released',
    mutate: (operation) => operation(),
  });
}

describe('export retention', () => {
  it.each([false, true])(
    'continues slow sorted top-level eligibility and restarts changed directories (%s)',
    async (changed) => {
      const f = fixture();
      const path = join(f.runtime.paths.coral.exports.jobsRoot, 'wide-residue');
      mkdirSync(path, { recursive: true });
      for (let i = 319; i >= 0; i -= 1) {
        const child = join(path, `old-${String(i).padStart(3, '0')}`);
        writeFileSync(child, 'old');
        utimesSync(child, 1, 1);
      }
      utimesSync(path, 1, 1);
      const lstat = f.runtime.storage.lstatSync;
      let elapsed = 0;
      const checked: string[] = [];
      f.runtime.storage.lstatSync = ((...args: Parameters<typeof lstat>) => {
        elapsed += 20;
        if (args[1]?.bigint && String(args[0]) !== path) checked.push(String(args[0]));
        return lstat(...args);
      }) as typeof lstat;
      let afterId = '';
      for (let cycle = 0; cycle < 4 && existsSync(path); cycle += 1) {
        elapsed = 0;
        checked.length = 0;
        afterId = await pruneJobExports({
          db: f.db,
          runtime: f.runtime,
          cutoff: RETENTION_CUTOFF + cycle * 86_400_000,
          afterId,
          budget: { canContinue: () => elapsed < 5000, record: f.budget.record },
          jobState: () => ({ kind: 'absent' }),
          resultHold: () => 'released',
          mutate: (operation) => operation(),
        });
        if (cycle === 0) {
          expect(checked).toEqual([...checked].sort());
          const saved = f.db
            .prepare<
              [],
              { value: string }
            >("SELECT value FROM meta WHERE key = 'storage-retention.exports.eligibility.v1'")
            .get();
          expect(saved).toBeDefined();
          expect(JSON.parse(saved!.value)).toMatchObject({
            jobId: 'wide-residue',
            lastEntry: 'old-255',
            newestMtimeNs: '1000000000',
          });
          expect(readdirSync(path)).toHaveLength(320);
          if (changed) {
            utimesSync(join(path, 'old-000'), new Date(RETENTION_NOW), new Date(RETENTION_NOW));
            utimesSync(path, 2, 2);
          }
        }
        if (cycle === 1) expect(checked[0]).toBe(join(path, changed ? 'old-000' : 'old-256'));
      }
      expect(existsSync(path)).toBe(changed);
      if (changed) expect(readdirSync(path)).toHaveLength(320);
    },
  );

  it.each([false, true])('retries partial residue deletion without resetting age (new content: %s)', async (fresh) => {
    const f = fixture();
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'residue');
    const cutoff = RETENTION_CUTOFF;
    mkdirSync(path, { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      const child = join(path, `old-${i}`);
      writeFileSync(child, 'old artifact');
      utimesSync(child, 1, 1);
    }
    utimesSync(path, 1, 1);
    let operations = 0;
    f.budget.canContinue = () => ++operations <= 18;
    const run = (when: number) =>
      pruneJobExports({
        db: f.db,
        runtime: f.runtime,
        cutoff: when,
        afterId: '',
        budget: f.budget,
        jobState: () => ({ kind: 'absent' }),
        resultHold: () => 'released',
        mutate: (operation) => operation(),
      });
    await run(cutoff);
    const remaining = readdirSync(path);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(10);
    expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'failed' }));
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.admission.v1.residue'),
    ).toEqual({ value: String(cutoff) });
    utimesSync(path, new Date(RETENTION_NOW), new Date(RETENTION_NOW));
    if (fresh) {
      writeFileSync(join(path, 'new-content'), 'new activity');
      const contentTime = new Date(cutoff + 43_200_000);
      utimesSync(join(path, 'new-content'), contentTime, contentTime);
    }
    f.budget.canContinue = () => true;
    await run(cutoff + 86_400_000);
    expect(existsSync(path)).toBe(fresh);
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.admission.v1.residue'),
    ).toBeUndefined();
    if (fresh) expect(readdirSync(path).sort()).toEqual([...remaining, 'new-content'].sort());
  });

  it('reaches an expired export after a retained 20,010-entry prefix', async () => {
    const f = fixture();
    const root = f.runtime.paths.coral.exports.jobsRoot;
    for (let i = 0; i < 20_010; i += 1)
      mkdirSync(join(root, `recent-${String(i).padStart(5, '0')}`), { recursive: true });
    const expired = join(root, 'z-expired');
    mkdirSync(expired);
    let afterId = '';
    const cursors: string[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      let operations = 0;
      afterId = await pruneJobExports({
        db: f.db,
        runtime: f.runtime,
        cutoff: RETENTION_CUTOFF,
        afterId,
        budget: { canContinue: () => ++operations <= 20_000, record: f.budget.record },
        jobState: (id) => (id === 'z-expired' ? { kind: 'terminal', terminalAt: 1 } : { kind: 'unknown' }),
        resultHold: () => 'released',
        mutate: (operation) => operation(),
      });
      cursors.push(afterId);
      if (!existsSync(expired)) break;
    }
    expect(cursors[0]).not.toBe('');
    expect(cursors.at(-1)).toBe('');
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(join(root, 'recent-00000'))).toBe(true);
  });

  it('resumes strictly after a removed cursor without spending the budget on earlier names', async () => {
    const f = fixture();
    const root = f.runtime.paths.coral.exports.jobsRoot;
    for (const id of ['a-kept', 'b-cursor', 'c-expired']) mkdirSync(join(root, id), { recursive: true });
    f.runtime.storage.rmdirSync(join(root, 'b-cursor'));
    let operations = 0;
    const visited: string[] = [];
    const next = await pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: 'b-cursor',
      budget: { canContinue: () => ++operations <= 5, record: f.budget.record },
      jobState: (id) => {
        visited.push(id);
        return { kind: 'terminal', terminalAt: 1 };
      },
      resultHold: () => 'released',
      mutate: (operation) => operation(),
    });
    expect(visited).toEqual(['c-expired']);
    expect(existsSync(join(root, 'a-kept'))).toBe(true);
    expect(existsSync(join(root, 'c-expired'))).toBe(false);
    expect(next).toBe('');
  });

  it('deletes the entire expired terminal export, keeping live, unknown, recent and epoch-required results', async () => {
    const f = fixture();
    for (const id of ['expired', 'live', 'unknown', 'recent', 'required', 'hold-unknown']) exported(f, id);
    await prune(
      f,
      {
        expired: { kind: 'terminal', terminalAt: RETENTION_CUTOFF - 1 },
        live: { kind: 'nonterminal' },
        unknown: { kind: 'unknown' },
        recent: { kind: 'terminal', terminalAt: RETENTION_CUTOFF },
        required: { kind: 'terminal', terminalAt: 1 },
        'hold-unknown': { kind: 'terminal', terminalAt: 1 },
      },
      { required: 'required', 'hold-unknown': 'unknown' },
    );
    expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, 'expired'))).toBe(false);
    for (const id of ['live', 'unknown', 'recent', 'required', 'hold-unknown'])
      expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, id, 'result.md'))).toBe(true);
    expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'deleted', count: 1 }));
  });

  it('checks top-level activity ages and never follows a job symlink', async () => {
    const f = fixture();
    const old = exported(f, 'old');
    const changed = exported(f, 'changed');
    for (const path of [old, changed]) {
      for (const child of ['result.md', 'provider-artifacts/original.jsonl', 'provider-artifacts', ''])
        utimesSync(join(path, child), 1, 1);
    }
    utimesSync(join(changed, 'provider-artifacts'), new Date(RETENTION_NOW), new Date(RETENTION_NOW));
    symlinkSync(changed, join(f.runtime.paths.coral.exports.jobsRoot, 'link'));
    await prune(f, {});
    expect(existsSync(old)).toBe(false);
    expect(existsSync(changed)).toBe(true);
    expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, 'link'))).toBe(true);
  });

  it.each(['', 'provider-artifacts'])(
    'keeps residue with recent directory activity and old content (%s)',
    async (changedDirectory) => {
      const f = fixture();
      const path = exported(f, 'recent-residue');
      for (const child of ['', 'result.md', 'provider-artifacts', 'provider-artifacts/original.jsonl'])
        utimesSync(join(path, child), 1, 1);
      utimesSync(join(path, changedDirectory), new Date(RETENTION_NOW), new Date(RETENTION_NOW));
      await prune(f, {});
      expect(existsSync(join(path, 'provider-artifacts/original.jsonl'))).toBe(true);
      expect(f.outcomes).toContainEqual(
        expect.objectContaining({ kind: 'kept', reason: 'residue-recent-or-unobservable' }),
      );
    },
  );

  it.each([
    [320, 20],
    [6000, 1],
  ])(
    'starts bounded eligibility and completes slow residue deletion across cycles (%i files, %i ms/stat)',
    async (files, cost) => {
      const f = fixture();
      const path = join(f.runtime.paths.coral.exports.jobsRoot, 'slow-residue');
      const nested = join(path, 'provider-artifacts');
      mkdirSync(nested, { recursive: true });
      for (let i = 0; i < files; i += 1) {
        const child = join(nested, `old-${i}`);
        writeFileSync(child, 'old');
        utimesSync(child, 1, 1);
      }
      for (const directory of [path, nested]) utimesSync(directory, 1, 1);
      const lstat = f.runtime.storage.lstatSync;
      let elapsed = 0;
      let unlinks = 0;
      f.runtime.storage.lstatSync = ((...args: Parameters<typeof lstat>) => {
        elapsed += cost;
        return lstat(...args);
      }) as typeof lstat;
      const unlink = f.runtime.storage.unlinkSync;
      f.runtime.storage.unlinkSync = (child) => {
        unlinks += 1;
        unlink(child);
      };
      let afterId = '';
      for (let cycle = 0; cycle < 3 && existsSync(path); cycle += 1) {
        elapsed = 0;
        afterId = await pruneJobExports({
          db: f.db,
          runtime: f.runtime,
          cutoff: RETENTION_CUTOFF + cycle * 86_400_000,
          afterId,
          budget: { canContinue: () => elapsed < 5000, record: f.budget.record },
          jobState: () => ({ kind: 'absent' }),
          resultHold: () => 'released',
          mutate: (operation) => operation(),
        });
        expect(unlinks).toBeGreaterThan(0);
        if (existsSync(path)) {
          utimesSync(path, new Date(RETENTION_NOW), new Date(RETENTION_NOW));
          utimesSync(nested, new Date(RETENTION_NOW), new Date(RETENTION_NOW));
        }
      }
      expect(existsSync(path)).toBe(false);
      expect(unlinks).toBe(files);
    },
  );

  it('keeps interrupted work and reports deletion failure for automatic retry', async () => {
    const f = fixture();
    const path = exported(f, 'expired');
    f.budget.canContinue = () => false;
    await prune(f, { expired: { kind: 'terminal', terminalAt: 1 } });
    expect(existsSync(path)).toBe(true);
    f.budget.canContinue = () => true;
    const runtime = {
      ...f.runtime,
      storage: {
        ...f.runtime.storage,
        unlinkSync: () => {
          throw new Error('injected unlink failure');
        },
      },
    };
    await pruneJobExports({
      db: f.db,
      runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: f.budget,
      jobState: () => ({ kind: 'terminal', terminalAt: 1 }),
      resultHold: () => 'released',
      mutate: (operation) => operation(),
    });
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({ kind: 'failed', reason: expect.stringContaining('injected unlink') }),
    );
    await prune(f, { expired: { kind: 'terminal', terminalAt: 1 } });
    expect(existsSync(path)).toBe(false);
  });

  it('derives age from the decoded journal terminal and keeps corrupt or absent state distinct', () => {
    const f = fixture();
    f.setNow(1);
    initTestJob(f.store, {
      jobId: 'job',
      sessionId: 'session',
      provider: 'codex',
      projectRoot: '/workspace',
      backendNamespace: 'test-ns',
    });
    expect(readExportJobState(f.db, f.store, 'job')).toEqual({ kind: 'nonterminal' });
    commitJobTerminal(f.store, 'job', 'session', { content: 'result', outcome: { kind: 'completed' }, durationMs: 1 });
    expect(readExportJobState(f.db, f.store, 'job')).toEqual({ kind: 'terminal', terminalAt: 1 });
    f.db.prepare("UPDATE events SET body = ? WHERE type = 'job.terminal.recorded'").run(Buffer.from('{}'));
    expect(readExportJobState(f.db, f.store, 'job')).toEqual({ kind: 'unknown' });
    expect(readExportJobState(f.db, f.store, 'residue')).toEqual({ kind: 'absent' });
  });

  it('retains the exact historical result until its epoch directory is proven absent', () => {
    const f = fixture();
    const locations = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    const epoch = {
      storeRoot: f.runtime.paths.coral.store.dbDir,
      epoch: '1',
      path: join(f.runtime.paths.coral.store.dbDir, 'epoch-1', 'store.db'),
    };
    locations.register('job', JSON.stringify(epoch), {
      projectRoot: '/workspace',
      workDir: '/workspace',
      jobKind: 'provider',
    });
    mkdirSync(join(epoch.storeRoot, 'epoch-1'), { recursive: true });
    expect(locations.exportResultRetention('job', 'active')).toBe('required');
    f.runtime.storage.rmSync(join(epoch.storeRoot, 'epoch-1'), { recursive: true });
    expect(locations.exportResultRetention('job', 'active')).toBe('released');
    locations.register('unknown', 'bad-epoch-key', {
      projectRoot: '/workspace',
      workDir: '/workspace',
      jobKind: 'provider',
    });
    expect(locations.exportResultRetention('unknown', 'active')).toBe('unknown');
  });

  it('releases unrelated old residue after ordinary location registration', async () => {
    const f = fixture();
    const locations = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    locations.register('current', 'active', { projectRoot: '/workspace', workDir: '/workspace', jobKind: 'provider' });
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'residue');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'old');
    for (const p of [path, join(path, 'result.md')]) utimesSync(p, 1, 1);
    await pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: f.budget,
      jobState: () => ({ kind: 'absent' }),
      resultHold: (id) => locations.exportResultRetention(id, 'active'),
      mutate: (operation) => operation(),
    });
    expect(existsSync(path)).toBe(false);
  });

  it.each(['nested', 'top-level'])(
    'finishes eligibility for a residue with a large descendant tree and removes it across retries (%s)',
    async (layout) => {
      const f = fixture();
      const path = join(f.runtime.paths.coral.exports.jobsRoot, 'large');
      const descendants = layout === 'nested' ? join(path, 'provider-artifacts') : path;
      mkdirSync(descendants, { recursive: true });
      for (let i = 0; i < 20_001; i += 1) {
        const child = join(descendants, `evidence-${i}`);
        writeFileSync(child, 'old');
        utimesSync(child, 1, 1);
      }
      for (const p of [path, descendants]) utimesSync(p, 1, 1);
      let cycles = 0;
      let previousRemaining = 20_001;
      while (existsSync(path)) {
        let operations = 0;
        await pruneJobExports({
          db: f.db,
          runtime: f.runtime,
          cutoff: Date.now() - 14 * 86_400_000,
          afterId: '',
          budget: { record: () => {}, canContinue: () => ++operations <= 20_000 },
          jobState: () => ({ kind: 'absent' }),
          resultHold: () => 'released',
          mutate: (operation) => operation(),
        });
        const remaining = existsSync(descendants) ? readdirSync(descendants).length : 0;
        expect(remaining).toBeLessThan(previousRemaining);
        previousRemaining = remaining;
        expect(++cycles).toBeLessThan(10);
      }
      expect(cycles).toBeGreaterThan(1);
      expect(existsSync(path)).toBe(false);
    },
  );

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
