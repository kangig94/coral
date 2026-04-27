import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { composeCoralPaths, corpusPaths, exportsPaths } from '#src/infra/path/compose.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { expansionPaths } from '#src/infra/path/expansion.js';
import { storePaths } from '#src/infra/path/store.js';

describe('composeCoralPaths', () => {
  it('returns a record covering all five path families', () => {
    const p = composeCoralPaths('prod');
    expect(Object.keys(p).sort()).toEqual(['coordinator', 'corpus', 'expansion', 'exports', 'store']);
    expect(p.store.dbFile).toContain('.coral/data/store/store.db');
    expect(p.corpus.kbRoot).toContain('.coral/kb');
    expect(p.coordinator.socketPath).toMatch(/\.coral\/run\/coordinator\.sock$|^\/.*\/coral-prod-[0-9a-f]{8}\.sock$/);
    expect(p.exports.jobsRoot).toContain('.coral/exports/jobs');
    expect(p.expansion.expansionRoot).toContain('.coral/data/expansion');
  });

  it('dev flavor has distinct segments from prod', () => {
    const prod = composeCoralPaths('prod');
    const dev = composeCoralPaths('dev');
    expect(dev.store.dbDir).not.toBe(prod.store.dbDir);
    expect(dev.store.dbDir).toContain('data-dev');
    expect(dev.corpus.kbRoot).toContain('kb-dev');
    expect(dev.coordinator.runDir).toContain('run-dev');
    expect(dev.exports.jobsRoot).toContain('exports-dev');
    expect(dev.expansion.expansionRoot).toContain('data-dev/expansion');
  });

  it('rejects mutation at compile time via readonly modifier', () => {
    const p = composeCoralPaths('prod');
    // @ts-expect-error — TypeScript readonly modifier blocks reassignment
    p.store = {} as never;
  });

  it('storePaths accepts an explicit baseDir', () => {
    expect(storePaths('prod', { baseDir: '/tmp/coral-root' })).toEqual({
      dbDir: join('/tmp/coral-root', 'data', 'store'),
      dbFile: join('/tmp/coral-root', 'data', 'store', 'store.db'),
      walFile: join('/tmp/coral-root', 'data', 'store', 'store.db-wal'),
    });
  });

  it('corpusPaths accepts an explicit baseDir', () => {
    expect(corpusPaths('dev', { baseDir: '/tmp/coral-root' })).toEqual({
      kbRoot: join('/tmp/coral-root', 'kb-dev'),
      notesDir: join('/tmp/coral-root', 'kb-dev', 'notes'),
      sourcesDir: join('/tmp/coral-root', 'kb-dev', 'sources'),
      principlesDir: join('/tmp/coral-root', 'kb-dev', 'principles'),
      communitiesDir: join('/tmp/coral-root', 'kb-dev', 'communities'),
    });
  });

  it('coordinatorPaths accepts an explicit baseDir', () => {
    expect(coordinatorPaths('prod', { TMPDIR: '/tmp' }, { baseDir: '/tmp/coral-root' })).toEqual({
      runDir: join('/tmp/coral-root', 'run'),
      socketPath: join('/tmp/coral-root', 'run', 'coordinator.sock'),
      infoFile: join('/tmp/coral-root', 'run', 'coordinator.json'),
      lockFile: join('/tmp/coral-root', 'run', 'coordinator.lock'),
    });
  });

  it('exportsPaths accepts an explicit baseDir', () => {
    expect(exportsPaths('dev', { baseDir: '/tmp/coral-root' })).toEqual({
      jobsRoot: join('/tmp/coral-root', 'exports-dev', 'jobs'),
    });
  });

  it('expansionPaths accepts an explicit baseDir and exposes per-name accessors', () => {
    const eq = expansionPaths('prod', { baseDir: '/tmp/coral-root' });
    expect(eq.expansionRoot).toBe(join('/tmp/coral-root', 'data', 'expansion'));
    expect(eq.dataDir('needle')).toBe(join('/tmp/coral-root', 'data', 'expansion', 'needle'));
    expect(eq.addonPath('needle')).toBe(
      join('/tmp/coral-root', 'data', 'expansion', 'needle', 'coral-needle.node'),
    );
    expect(eq.addonPath('cgc')).toBe(join('/tmp/coral-root', 'data', 'expansion', 'cgc', 'cgc.node'));
    expect(eq.installLockPath('needle')).toBe(
      join('/tmp/coral-root', 'data', 'expansion', 'needle', 'install.lock'),
    );
  });
});
