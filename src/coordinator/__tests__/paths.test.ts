import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { composeCoralPaths } from '../paths.js';
import { coordinatorPaths } from '../info.js';
import { corpusPaths } from '../../kb/corpus/paths.js';
import { equipmentPaths } from '../../infra/equipment-paths.js';
import { exportsPaths } from '../../jobs/exports/paths.js';
import { storePaths } from '../../store/paths.js';

describe('composeCoralPaths', () => {
  it('returns a frozen record covering all five path families', () => {
    const p = composeCoralPaths('prod');
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.keys(p).sort()).toEqual(['coordinator', 'corpus', 'equipment', 'exports', 'store']);
    expect(p.store.dbFile).toContain('.coral/data/store/store.db');
    expect(p.corpus.kbRoot).toContain('.coral/kb');
    expect(p.coordinator.socketPath).toMatch(/\.coral\/run\/coordinator\.sock$|^\/.*\/coral-prod-[0-9a-f]{8}\.sock$/);
    expect(p.exports.jobsRoot).toContain('.coral/exports/jobs');
    expect(p.equipment.equipmentRoot).toContain('.coral/data/equipment');
  });

  it('dev flavor has distinct segments from prod', () => {
    const prod = composeCoralPaths('prod');
    const dev = composeCoralPaths('dev');
    expect(dev.store.dbDir).not.toBe(prod.store.dbDir);
    expect(dev.store.dbDir).toContain('data-dev');
    expect(dev.corpus.kbRoot).toContain('kb-dev');
    expect(dev.coordinator.runDir).toContain('run-dev');
    expect(dev.exports.jobsRoot).toContain('exports-dev');
    expect(dev.equipment.equipmentRoot).toContain('data-dev/equipment');
  });

  it('throws when attempting to mutate the frozen record', () => {
    const p = composeCoralPaths('prod');
    expect(() => {
      // @ts-expect-error — mutation is what we are asserting fails
      p.store = {} as never;
    }).toThrow();
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
      derivedDir: join('/tmp/coral-root', 'kb-dev', 'derived'),
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

  it('equipmentPaths accepts an explicit baseDir', () => {
    expect(equipmentPaths('prod', { baseDir: '/tmp/coral-root' })).toEqual({
      equipmentRoot: join('/tmp/coral-root', 'data', 'equipment'),
    });
  });
});
