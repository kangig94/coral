import { encodeResolvedStoreEpoch } from '#src/store/epoch/observation.js';
import { protectStoreEpoch, protectedStoreEpochRoot } from '#src/store/epoch/protection.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import type { Runtime } from '#src/runtime/ports.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, renameSync, unlinkSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

  it('checks top-level residue ages and never follows a job symlink', async () => {
    const f = fixture();
    const old = exported(f, 'old');
    const changed = exported(f, 'changed');
    for (const path of [old, changed]) {
      for (const child of ['result.md', 'provider-artifacts/original.jsonl', 'provider-artifacts', ''])
        utimesSync(join(path, child), 1, 1);
    }
    utimesSync(join(old, 'provider-artifacts', 'original.jsonl'), new Date(RETENTION_NOW), new Date(RETENTION_NOW));
    utimesSync(join(changed, 'provider-artifacts'), new Date(RETENTION_CUTOFF), new Date(RETENTION_CUTOFF));
    symlinkSync(changed, join(f.runtime.paths.coral.exports.jobsRoot, 'link'));
    await prune(f, {});
    expect(existsSync(old)).toBe(false);
    expect(existsSync(changed)).toBe(true);
    expect(existsSync(join(f.runtime.paths.coral.exports.jobsRoot, 'link'))).toBe(true);
  });

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
      writeFileSync(join(descendants, 'evidence'), 'old');
      for (const p of [path, descendants, join(descendants, 'evidence')]) utimesSync(p, 1, 1);
      const iterate = f.runtime.storage.iterateDirectory;
      let remaining = 20_001;
      let visited = 0;
      const stat = f.runtime.storage.lstatSync;
      const unlink = f.runtime.storage.unlinkSync;
      f.runtime.storage.iterateDirectory = async function* (p) {
        if (p === descendants) {
          for (let i = 0; i < remaining; i += 1) yield `virtual-${i}`;
          yield 'evidence';
        } else yield* iterate(p);
      };
      vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation((...args) => {
        if (String(args[0]).startsWith(descendants + '/virtual-')) {
          visited += 1;
          return stat(join(descendants, 'evidence'), args[1]);
        }
        return stat(...args);
      });
      const remove = vi.spyOn(f.runtime.storage, 'unlinkSync').mockImplementation((p) => {
        if (String(p).startsWith(descendants + '/virtual-')) return;
        unlink(p);
      });
      let cycles = 0;
      while (remaining > 0) {
        let operations = 0;
        const countVirtual = () => remove.mock.calls.filter(([p]) => String(p).includes('/virtual-')).length;
        const before = countVirtual();
        await pruneJobExports({
          runtime: f.runtime,
          cutoff: RETENTION_CUTOFF,
          afterId: '',
          budget: { record: () => {}, canContinue: () => ++operations <= 20_000 },
          jobState: () => ({ kind: 'absent' }),
          resultHold: () => 'released',
          mutate: (operation) => operation(),
        });
        remaining -= countVirtual() - before;
        expect(++cycles).toBeLessThan(10);
      }
      expect(visited).toBeGreaterThan(20_001);
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
