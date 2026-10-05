import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import type { JobDetailResponse } from '#src/jobs/records.js';
import { encodeResolvedStoreEpoch } from '#src/store/epoch/observation.js';
import { protectStoreEpoch, protectedStoreEpochRoot } from '#src/store/epoch/protection.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import type { Runtime } from '#src/runtime/ports.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  for (const child of ['', 'result.md', 'provider-artifacts', 'provider-artifacts/original.jsonl'])
    utimesSync(join(path, child), 1, 1);
  return path;
}
function remainingExport(f: ReturnType<typeof fixture>, id: string): string | undefined {
  const root = f.runtime.paths.coral.exports.jobsRoot;
  const name = readdirSync(root).find((name) => name === id || name.startsWith(`.retiring-${id}-`));
  return name === undefined ? undefined : join(root, name);
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
  it('finishes a slow 320-entry eligibility scan in one slice, then deletes across retries', async () => {
    const f = fixture();
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'wide-residue');
    mkdirSync(path, { recursive: true });
    for (let i = 0; i < 320; i += 1) {
      const child = join(path, `old-${String(i).padStart(3, '0')}`);
      writeFileSync(child, 'old');
      utimesSync(child, 1, 1);
    }
    utimesSync(path, 1, 1);
    const lstat = f.runtime.storage.lstatSync;
    let elapsed = 0;
    const checked = new Set<string>();
    f.runtime.storage.lstatSync = ((...args: Parameters<typeof lstat>) => {
      elapsed += 20;
      if (String(args[0]).startsWith(`${path}/`)) checked.add(String(args[0]));
      return lstat(...args);
    }) as typeof lstat;
    const run = () =>
      pruneJobExports({
        db: f.db,
        runtime: f.runtime,
        cutoff: RETENTION_CUTOFF,
        afterId: '',
        budget: { canContinue: () => elapsed < 5000, record: f.budget.record },
        jobState: () => ({ kind: 'absent' }),
        resultHold: () => 'released',
        mutate: (operation) => operation(),
      });
    await run();
    expect(checked.size).toBe(320);
    expect(readdirSync(path)).toHaveLength(320);
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.eligibility.v1'),
    ).toBeUndefined();
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.admission.v1.wide-residue'),
    ).toEqual({ value: String(RETENTION_CUTOFF) });
    for (let cycle = 0; cycle < 20 && existsSync(path); cycle += 1) {
      elapsed = 0;
      await run();
    }
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    ['file', 'absent'],
    ['directory', 'absent'],
    ['file', 'terminal'],
    ['directory', 'terminal'],
  ] as const)('keeps a top-level %s rewritten after eligibility (%s)', async (kind, state) => {
    const f = fixture();
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'rewritten');
    const child = join(path, 'old-000');
    mkdirSync(path, { recursive: true });
    if (kind === 'directory') mkdirSync(child);
    else writeFileSync(child, 'old');
    utimesSync(child, 1, 1);
    utimesSync(path, 1, 1);
    await pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: f.budget,
      jobState: () => (state === 'terminal' ? { kind: 'terminal', terminalAt: 1 } : { kind: 'absent' }),
      resultHold: () => {
        if (kind === 'directory') writeFileSync(join(child, 'new-result.md'), 'fresh');
        else writeFileSync(child, 'fresh');
        utimesSync(child, new Date(RETENTION_NOW), new Date(RETENTION_NOW));
        return 'released';
      },
      mutate: (operation) => operation(),
    });
    expect(existsSync(child)).toBe(true);
    if (kind === 'directory') expect(existsSync(join(child, 'new-result.md'))).toBe(true);
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({ kind: 'kept', reason: 'residue-recent-or-unobservable' }),
    );
  });

  it.each(['file', 'directory'])(
    'ignores obsolete eligibility prefixes when a top-level %s was rewritten',
    async (kind) => {
      const f = fixture();
      const path = join(f.runtime.paths.coral.exports.jobsRoot, 'checkpoint-residue');
      mkdirSync(path, { recursive: true });
      for (let i = 0; i < 320; i += 1) {
        const child = join(path, `old-${String(i).padStart(3, '0')}`);
        if (kind === 'directory') mkdirSync(child);
        else writeFileSync(child, 'old');
        utimesSync(child, 1, 1);
      }
      utimesSync(path, 1, 1);
      f.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'storage-retention.exports.eligibility.v1',
        JSON.stringify({
          jobId: 'checkpoint-residue',
          lastEntry: 'old-255',
          directoryMtimeNs: '1000000000',
          newestMtimeNs: '1000000000',
          admitted: false,
        }),
      );
      const child = join(path, 'old-000');
      if (kind === 'directory') writeFileSync(join(child, 'new-result.md'), 'fresh');
      else writeFileSync(child, 'fresh');
      utimesSync(child, new Date(RETENTION_NOW), new Date(RETENTION_NOW));
      await prune(f, {});
      expect(existsSync(child)).toBe(true);
      expect(readdirSync(path)).toHaveLength(320);
      expect(
        f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.eligibility.v1'),
      ).toBeUndefined();
    },
  );

  it.each(['file', 'directory'])('rechecks a recently rewritten admitted top-level %s on retry', async (kind) => {
    const f = fixture();
    const path = join(f.runtime.paths.coral.exports.jobsRoot, 'admitted');
    const child = join(path, 'old-000');
    mkdirSync(path, { recursive: true });
    if (kind === 'directory') mkdirSync(child);
    else writeFileSync(child, 'old');
    utimesSync(child, 1, 1);
    utimesSync(path, 1, 1);
    f.db
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
      .run('storage-retention.exports.admission.v1.admitted', String(RETENTION_CUTOFF));
    if (kind === 'directory') writeFileSync(join(child, 'new-result.md'), 'fresh');
    else writeFileSync(child, 'fresh');
    utimesSync(child, new Date(RETENTION_NOW), new Date(RETENTION_NOW));
    await prune(f, {});
    expect(existsSync(child)).toBe(true);
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.admission.v1.admitted'),
    ).toBeUndefined();
    await pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_NOW + 1,
      afterId: '',
      budget: f.budget,
      jobState: () => ({ kind: 'absent' }),
      resultHold: () => 'released',
      mutate: (operation) => operation(),
    });
    expect(existsSync(path)).toBe(false);
  });

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
    const retired = remainingExport(f, 'residue')!;
    expect(retired).not.toBe(path);
    const remaining = readdirSync(retired);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.length).toBeLessThan(10);
    expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'failed' }));
    expect(
      f.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(`storage-retention.exports.admission.v1.${basename(retired)}`),
    ).toEqual({ value: String(cutoff) });
    if (fresh) {
      writeFileSync(join(retired, 'new-content'), 'new activity');
      const contentTime = new Date(cutoff + 43_200_000);
      utimesSync(join(retired, 'new-content'), contentTime, contentTime);
    }
    f.budget.canContinue = () => true;
    await run(cutoff + 86_400_000);
    expect(remainingExport(f, 'residue') !== undefined).toBe(fresh);
    expect(
      f.db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(`storage-retention.exports.admission.v1.${basename(retired)}`),
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
      for (let cycle = 0; cycle < 20 && remainingExport(f, 'slow-residue') !== undefined; cycle += 1) {
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
      }
      expect(remainingExport(f, 'slow-residue')).toBeUndefined();
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
      while (remainingExport(f, 'large') !== undefined) {
        let operations = 0;
        await pruneJobExports({
          db: f.db,
          runtime: f.runtime,
          cutoff: RETENTION_CUTOFF,
          afterId: '',
          budget: { record: () => {}, canContinue: () => ++operations <= 20_000 },
          jobState: () => ({ kind: 'absent' }),
          resultHold: () => 'released',
          mutate: (operation) => operation(),
        });
        const current = remainingExport(f, 'large');
        const currentDescendants =
          current === undefined ? undefined : layout === 'nested' ? join(current, 'provider-artifacts') : current;
        const remaining =
          currentDescendants !== undefined && existsSync(currentDescendants)
            ? readdirSync(currentDescendants).length
            : 0;
        expect(remaining).toBeLessThan(previousRemaining);
        previousRemaining = remaining;
        expect(++cycles).toBeLessThan(10);
      }
      expect(cycles).toBeGreaterThan(1);
      expect(remainingExport(f, 'large')).toBeUndefined();
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

it('bounds export pending failures and reports overflow until failures clear', async () => {
  const f = fixture();
  const ids = Array.from({ length: 101 }, (_, i) => `overflow-${String(i).padStart(3, '0')}`);
  const states: Record<string, ExportJobRetentionState> = {};
  for (const id of ids) {
    exported(f, id);
    states[id] = { kind: 'terminal', terminalAt: 1 };
  }
  const unlink = f.runtime.storage.unlinkSync;
  f.runtime.storage.unlinkSync = () => {
    throw new Error('persistent export EACCES');
  };
  try {
    await prune(f, states);
    expect(f.outcomes).toContainEqual(expect.objectContaining({ reason: 'export-pending-overflow' }));
    const saved = f.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get('storage-retention.exports.pending.v1');
    expect(JSON.parse(saved!.value).subjects).toHaveLength(100);
    f.runtime.storage.unlinkSync = unlink;
    await prune(f, states);
    expect(ids.some((id) => existsSync(join(f.runtime.paths.coral.exports.jobsRoot, id)))).toBe(false);
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.pending.v1'),
    ).toBeUndefined();
  } finally {
    f.runtime.storage.unlinkSync = unlink;
  }
});

it.each(['eligibility', 'post-rename', 'deletion'] as const)(
  'does not mutate after a delayed %s read loses its owner',
  async (pause) => {
    const f = fixture();
    const root = f.runtime.paths.coral.exports.jobsRoot;
    const path = join(root, 'expired');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'old'), 'old');
    utimesSync(join(path, 'old'), 1, 1);
    utimesSync(path, 1, 1);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const read = f.runtime.storage.readdir.bind(f.runtime.storage);
    f.runtime.storage.readdir = async (directory) => {
      if (
        (pause === 'eligibility' && directory === path) ||
        (pause === 'post-rename' && directory.includes('.retiring-'))
      ) {
        started();
        await blocked;
      }
      return read(directory);
    };
    const iterate = f.runtime.storage.iterateDirectory.bind(f.runtime.storage);
    f.runtime.storage.iterateDirectory = async function* (directory) {
      if (pause === 'deletion' && directory.includes('.retiring-')) {
        started();
        await blocked;
      }
      yield* iterate(directory);
    };
    let active = true;
    const run = pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: { canContinue: () => active, canMutate: () => active, record: f.budget.record },
      jobState: () => ({ kind: 'absent' }),
      resultHold: () => 'released',
      mutate: (operation) => operation(),
    });
    await ready;
    const meta = f.db.prepare('SELECT key, value FROM meta ORDER BY key').all();
    const names = readdirSync(root);
    active = false;
    release();
    await run;
    expect(f.db.prepare('SELECT key, value FROM meta ORDER BY key').all()).toEqual(meta);
    expect(readdirSync(root)).toEqual(names);
    expect(existsSync(join(root, names[0], 'old'))).toBe(true);
  },
);

it.each(['', '.', '..', '../outside', 'nested/outside', 'nested\\outside', 'nul\0name'])(
  'refuses persisted export subject %j before resolving a path',
  async (subject) => {
    const f = fixture();
    const root = f.runtime.paths.coral.exports.jobsRoot;
    mkdirSync(root, { recursive: true });
    const outside = join(dirname(root), 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside evidence');
    utimesSync(join(outside, 'keep.txt'), 1, 1);
    utimesSync(outside, 1, 1);
    f.db
      .prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
      .run(
        'storage-retention.exports.pending.v1',
        JSON.stringify({ subjects: [subject], overflow: false, rotation: 0 }),
      );
    const jobState = vi.fn(() => ({ kind: 'absent' as const }));
    await pruneJobExports({
      db: f.db,
      runtime: f.runtime,
      cutoff: RETENTION_CUTOFF,
      afterId: '',
      budget: f.budget,
      jobState,
      resultHold: () => 'released',
      mutate: (operation) => operation(),
    });
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(jobState).not.toHaveBeenCalled();
    expect(f.outcomes).toContainEqual({ kind: 'kept', subject, reason: 'retention-subject-invalid', pending: false });
    expect(
      f.db.prepare('SELECT value FROM meta WHERE key = ?').get('storage-retention.exports.pending.v1'),
    ).toBeUndefined();
  },
);

it.each(['symlink', 'directory'] as const)(
  'keeps a directory replaced by a %s during export enumeration',
  async (replacement) => {
    const f = fixture();
    const root = f.runtime.paths.coral.exports.jobsRoot;
    const path = join(root, 'safe-job');
    const nested = join(path, 'nested');
    const outside = join(dirname(root), 'outside-tree');
    mkdirSync(nested, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside evidence');
    for (const entry of [join(outside, 'keep.txt'), outside, nested, path]) utimesSync(entry, 1, 1);
    const iterate = f.runtime.storage.iterateDirectory;
    let replaced = false;
    f.runtime.storage.iterateDirectory = async function* (directory) {
      if (directory.includes('.retiring-') && directory.endsWith('/nested') && !replaced) {
        replaced = true;
        const parent = lstatSync(dirname(directory));
        const before = lstatSync(directory);
        renameSync(directory, join(dirname(root), 'saved-nested'));
        if (replacement === 'symlink') {
          symlinkSync(outside, directory);
          lutimesSync(directory, before.atime, before.mtime);
        } else {
          mkdirSync(directory);
          writeFileSync(join(directory, 'keep.txt'), 'replacement evidence');
          utimesSync(join(directory, 'keep.txt'), 1, 1);
          utimesSync(directory, before.atime, before.mtime);
        }
        utimesSync(dirname(directory), parent.atime, parent.mtime);
      }
      yield* iterate(directory);
    };
    await prune(f, {});
    expect(replaced).toBe(true);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(join(path, 'nested', 'keep.txt'))).toBe(true);
    expect(f.outcomes).toContainEqual(
      expect.objectContaining({ kind: 'kept', reason: 'residue-recent-or-unobservable' }),
    );
  },
);

it('retries a valid persisted export subject and unlinks an old nested symlink without following it', async () => {
  const f = fixture();
  const path = exported(f, 'safe-job');
  const outside = join(dirname(f.runtime.paths.coral.exports.jobsRoot), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'outside evidence');
  const link = join(path, 'outside-link');
  symlinkSync(outside, link);
  lutimesSync(link, 1, 1);
  utimesSync(path, 1, 1);
  f.db
    .prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
    .run(
      'storage-retention.exports.pending.v1',
      JSON.stringify({ subjects: ['safe-job'], overflow: false, rotation: 0 }),
    );
  await prune(f, {});
  expect(existsSync(path)).toBe(false);
  expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  expect(f.outcomes).toContainEqual(expect.objectContaining({ kind: 'deleted' }));
});

it('refuses a retirement rename after the exports root is replaced by a symlink', async () => {
  const f = fixture();
  const root = f.runtime.paths.coral.exports.jobsRoot;
  exported(f, 'safe-job');
  const outside = join(dirname(root), 'outside-root');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'outside evidence');
  const rename = vi.spyOn(f.runtime.storage, 'renameSync');
  let replaced = false;
  f.runtime.storage.iterateDirectory = async function* () {
    if (!replaced) {
      replaced = true;
      renameSync(root, join(dirname(root), 'saved-jobs'));
      symlinkSync(outside, root);
    }
    yield 'keep.txt';
  };
  await prune(f, {});
  expect(replaced).toBe(true);
  expect(rename).toHaveBeenCalledOnce();
  expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  expect(f.outcomes).toContainEqual(expect.objectContaining({ reason: 'export-root-identity-changed' }));
});

it('batches deletion evidence into bounded transactions without holding a transaction across async reads', async () => {
  const f = fixture();
  const path = join(f.runtime.paths.coral.exports.jobsRoot, 'many-files');
  mkdirSync(path, { recursive: true });
  for (let n = 0; n < 100; n++) {
    writeFileSync(join(path, String(n)), 'old');
    utimesSync(join(path, String(n)), 1, 1);
  }
  utimesSync(path, 1, 1);
  let writesInTurn = 0;
  let maxWritesInTurn = 0;
  const unlink = f.runtime.storage.unlinkSync;
  f.runtime.storage.unlinkSync = (path) => {
    expect(f.db.isTransaction).toBe(true);
    writesInTurn++;
    unlink(path);
  };
  const iterate = f.runtime.storage.iterateDirectory;
  f.runtime.storage.iterateDirectory = async function* (path) {
    expect(f.db.isTransaction).toBe(false);
    for await (const child of iterate(path)) {
      expect(f.db.isTransaction).toBe(false);
      yield child;
    }
  };
  const exec = vi.spyOn(f.db, 'exec');
  await pruneJobExports({
    db: f.db,
    runtime: f.runtime,
    cutoff: RETENTION_CUTOFF,
    afterId: '',
    budget: f.budget,
    jobState: () => ({ kind: 'absent' }),
    resultHold: () => 'released',
    mutate: (operation) => {
      writesInTurn = 0;
      const result = operation();
      maxWritesInTurn = Math.max(maxWritesInTurn, writesInTurn);
      return result;
    },
  });
  expect(existsSync(path)).toBe(false);
  expect(maxWritesInTurn).toBe(8);
  expect(exec.mock.calls.filter(([sql]) => sql === 'COMMIT').length).toBeLessThan(25);
});

it('retires small expired residues in bounded fenced turns while preserving identity, age and owner gates', async () => {
  const f = fixture();
  for (const id of ['expired', 'recent', 'held']) {
    const path = join(f.runtime.paths.coral.exports.jobsRoot, id);
    mkdirSync(join(path, 'provider-artifacts'), { recursive: true });
    writeFileSync(join(path, 'result.md'), 'old');
    utimesSync(join(path, 'result.md'), 1, 1);
    utimesSync(join(path, 'provider-artifacts'), 1, 1);
    const modifiedAt = id === 'recent' ? RETENTION_NOW / 1000 : 1;
    utimesSync(path, modifiedAt, modifiedAt);
  }
  const exec = vi.spyOn(f.db, 'exec');
  await pruneJobExports({
    db: f.db,
    runtime: f.runtime,
    cutoff: RETENTION_CUTOFF,
    afterId: '',
    budget: f.budget,
    jobState: () => ({ kind: 'absent' }),
    resultHold: (id) => (id === 'held' ? 'required' : 'released'),
    mutate: (operation) => operation(),
  });
  expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, 'expired'))).toBe(false);
  for (const id of ['recent', 'held']) expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, id))).toBe(true);
  expect(f.db.prepare("SELECT key FROM meta WHERE key LIKE 'storage-retention.exports.admission.v1.%'").all()).toEqual(
    [],
  );
  expect(exec.mock.calls.filter(([sql]) => sql === 'COMMIT').length).toBeLessThanOrEqual(6);
});

import { terminalEligibility } from '#src/jobs/export-retention.js';
import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';

it.each(['saved expired', 'source absent', 'source throws', 'source contradicts', 'inside', 'untrusted'])(
  'classifies terminal eligibility evidence: %s',
  (scenario) => {
    const f = createTerminalExportFixture();
    try {
      f.complete({ terminalAt: scenario === 'saved expired' ? TERMINAL_EXPORT_CUTOFF - 1000 : undefined });
      const location = f.index.read(f.jobId)!;
      if (scenario === 'untrusted') f.jump(120_000);
      const source = vi.fn((read: (db: typeof f.db) => unknown) => {
        if (scenario === 'source throws') throw new Error('transient');
        if (scenario === 'source absent') return null;
        if (scenario === 'source contradicts')
          f.db.prepare("DELETE FROM events WHERE type = 'job.terminal.recorded'").run();
        return read(f.db);
      });
      const eligibility = terminalEligibility(f.runtime, location, source as never);
      expect(eligibility.kind).toBe(
        scenario === 'saved expired' ? 'expired' : scenario === 'untrusted' ? 'unknown' : 'inside',
      );
      expect(eligibility.sourceReadFailed).toBe(scenario === 'source throws');
      expect(eligibility.sourceContradictory).toBe(scenario === 'source contradicts');
      expect(eligibility.publicationAuthorized).toBe(scenario === 'inside');
      expect(source).toHaveBeenCalledTimes(scenario === 'saved expired' ? 0 : 1);
    } finally {
      f.close();
    }
  },
);

it.each([
  'no location',
  'nonterminal location',
  'absent detail',
  'absent sequence',
  'invalid retained terminal',
  'saved unknown',
  'saved regression',
  'legacy age',
  'legacy source absent',
  'source timestamp mismatch',
  'source outcome mismatch',
  'source body corrupt',
  'source observation suppressed',
])('classifies terminal eligibility return path: %s', (scenario) => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    let location = f.index.read(f.jobId);
    if (!location) throw new Error('missing fixture location');
    if (scenario === 'nonterminal location') location = { ...location, disposition: 'unresolved' };
    if (scenario === 'absent detail') location = { ...location, detail: { kind: 'absent' } };
    if (scenario === 'absent sequence') location = { ...location, terminalSeq: undefined };
    if (scenario === 'invalid retained terminal' && location.detail.kind === 'recorded')
      location = {
        ...location,
        detail: {
          kind: 'recorded',
          value: { ...location.detail.value, status: { ...location.detail.value.status, updatedAt: 'invalid' } },
        },
      };
    if (scenario === 'saved unknown' || scenario === 'saved regression')
      location = {
        ...location,
        terminalAge: { ...location.terminalAge!, kind: scenario === 'saved unknown' ? 'unknown' : 'regression' },
      };
    if (scenario.startsWith('legacy')) location = { ...location, terminalAge: undefined };
    if (scenario === 'source timestamp mismatch')
      f.db.prepare("UPDATE events SET ts = '2099-01-01T00:00:00Z' WHERE type = 'job.terminal.recorded'").run();
    if (scenario === 'source outcome mismatch' || scenario === 'source body corrupt') {
      const row = f.db.prepare("SELECT body FROM events WHERE type = 'job.terminal.recorded'").get() as {
        body: Uint8Array;
      };
      const body = JSON.parse(Buffer.from(row.body).toString('utf8'));
      body.terminal.content = 'different content';
      f.db
        .prepare("UPDATE events SET body = ? WHERE type = 'job.terminal.recorded'")
        .run(Buffer.from(scenario === 'source body corrupt' ? '{' : JSON.stringify(body)));
    }
    const source = vi.fn((read: (db: typeof f.db) => unknown) =>
      scenario === 'legacy source absent' ? null : read(f.db),
    );
    const eligibility = terminalEligibility(
      f.runtime,
      scenario === 'no location' ? null : location,
      source as never,
      scenario !== 'source observation suppressed',
    );
    const denied = [
      'no location',
      'nonterminal location',
      'absent detail',
      'absent sequence',
      'invalid retained terminal',
    ].includes(scenario);
    expect(source).toHaveBeenCalledTimes(denied || scenario === 'source observation suppressed' ? 0 : 1);
    expect(eligibility.kind).toBe(
      denied || scenario === 'saved unknown' || scenario === 'legacy source absent'
        ? 'unknown'
        : scenario === 'saved regression'
          ? 'regression'
          : 'inside',
    );
    expect(eligibility.publicationAuthorized).toBe(['saved regression', 'legacy age'].includes(scenario));
    expect(eligibility.sourceReadFailed === true).toBe(scenario === 'source body corrupt');
    expect(eligibility.sourceContradictory === true).toBe(
      scenario === 'source timestamp mismatch' || scenario === 'source outcome mismatch',
    );
  } finally {
    f.close();
  }
});

describe('retired legacy exports', () => {
  function detail(jobId: string, ts: string): JobDetailResponse {
    const result = { content: 'done', outcome: { kind: 'completed' as const }, durationMs: 1 };
    return {
      status: {
        jobId,
        owner: { kind: 'provider-session', id: 's' },
        sessionId: 's',
        provider: 'claude',
        projectRoot: '/w/p',
        workDir: canonicalWorkDirWireSchema.parse('/w/p'),
        backendNamespace: 't',
        jobKind: 'provider',
        phase: 'completed',
        updatedAt: ts,
        result,
      },
      events: [{ type: 'terminal', jobId, sessionId: 's', seq: 2, ts, result }],
      readiness: 'ready',
      exit: { ...result, diagnostics: { progressFaults: [] }, endTime: ts },
    } as JobDetailResponse;
  }

  async function run(useAuthority: boolean) {
    const f = createRetentionFixture();
    fixtures.push(f);
    const index = new JobLocationIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    const storeRoot = join(f.baseDir, 'store');
    const retiredKey = JSON.stringify({ storeRoot, epoch: '1', path: join(storeRoot, 'epoch-1', 'store.db') });
    const jobId = 'legacy-job';
    // a v0.10.15-17 terminal location record (no terminalAge) whose epoch has since retired
    index.register(jobId, retiredKey, { projectRoot: '/w/p', workDir: '/w/p', jobKind: 'provider' });
    index.recordTerminal(
      jobId,
      detail(jobId, '2026-01-01T00:00:00.000Z'),
      join(f.runtime.paths.coral.exports.jobsRoot, jobId, 'result.md'),
      2,
    );
    const path = join(f.runtime.paths.coral.exports.jobsRoot, jobId);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'result.md'), 'old result');
    utimesSync(join(path, 'result.md'), 1, 1);
    utimesSync(path, 1, 1);
    for (let i = 0; i < 5; i++)
      await pruneJobExports({
        db: f.db,
        runtime: f.runtime,
        cutoff: RETENTION_CUTOFF,
        afterId: '',
        budget: f.budget,
        jobState: () => ({ kind: 'absent' }),
        resultHold: (id) => index.exportResultRetention(id, null),
        mutate: (op) => op(),
        ...(useAuthority
          ? { eligibility: (id: string) => (index.read(id) === null ? undefined : index.exportDeletionEligibility(id)) }
          : {}),
      });
    return existsSync(path);
  }

  it('a retired-epoch legacy export (terminal ~9 months old) is eventually reclaimed', async () => {
    const base = await run(false);
    const branch = await run(true);
    expect(base).toBe(false);
    expect(branch).toBe(false);
  });
});
