import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { composeCoralPaths, corpusPaths, exportsPaths, projectsPaths } from '#src/infra/path/index.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { enginePaths } from '#src/infra/path/engine.js';
import { storePaths } from '#src/infra/path/store.js';

describe('composeCoralPaths', () => {
  it('returns a record covering all seven path families', () => {
    const p = composeCoralPaths('prod');
    expect(Object.keys(p).sort()).toEqual([
      'coordinator',
      'corpus',
      'engine',
      'exports',
      'kbRuntime',
      'projects',
      'store',
    ]);
    expect(p.store.dbFile).toContain('.coral/gen2/data/store/store.db');
    expect(p.corpus.kbRoot).toContain('.coral/kb');
    // Sibling of gen2/data/store and gen2/data/engines, and distinct from corpus.kbRoot (the Markdown vault).
    expect(p.kbRuntime.root).toContain('.coral/gen2/data/kb');
    expect(p.coordinator.socketPath).toMatch(
      /\.coral\/gen2\/run\/coordinator\.sock$|^\/.*\/coral-prod-[0-9a-f]{8}\.sock$/,
    );
    expect(p.exports.jobsRoot).toContain('.coral/exports/jobs');
    expect(p.engine.engineRoot).toContain('.coral/gen2/data/engines');
    expect(p.projects.root).toContain('.coral/projects');
  });

  it('dev flavor has distinct segments from prod', () => {
    const prod = composeCoralPaths('prod');
    const dev = composeCoralPaths('dev');
    expect(dev.store.dbDir).not.toBe(prod.store.dbDir);
    expect(dev.store.dbDir).toContain('data-dev');
    expect(dev.corpus.kbRoot).toContain('kb-dev');
    expect(dev.coordinator.runDir).toContain('run-dev');
    expect(dev.exports.jobsRoot).toContain('exports-dev');
    expect(dev.engine.engineRoot).toContain('data-dev/engines');
    expect(dev.projects.root).not.toBe(prod.projects.root);
    expect(dev.projects.root).toContain('projects-dev');
  });

  it('rejects mutation at compile time via readonly modifier', () => {
    const p = composeCoralPaths('prod');
    // @ts-expect-error — TypeScript readonly modifier blocks reassignment
    p.store = {} as never;
  });

  it('storePaths accepts an explicit baseDir', () => {
    expect(storePaths('prod', { baseDir: '/tmp/coral-root' })).toEqual({
      dbDir: join('/tmp/coral-root', 'gen2', 'data', 'store'),
      dbFile: join('/tmp/coral-root', 'gen2', 'data', 'store', 'store.db'),
      walFile: join('/tmp/coral-root', 'gen2', 'data', 'store', 'store.db-wal'),
      shmFile: join('/tmp/coral-root', 'gen2', 'data', 'store', 'store.db-shm'),
    });
  });

  it('corpusPaths accepts an explicit baseDir', () => {
    expect(corpusPaths('dev', { baseDir: '/tmp/coral-root' })).toEqual({
      kbRoot: join('/tmp/coral-root', 'kb-dev'),
      notesDir: join('/tmp/coral-root', 'kb-dev', 'notes'),
      sourcesDir: join('/tmp/coral-root', 'kb-dev', 'sources'),
      principlesDir: join('/tmp/coral-root', 'kb-dev', 'principles'),
      communitiesDir: join('/tmp/coral-root', 'kb-dev', 'communities'),
      wikiDir: join('/tmp/coral-root', 'kb-dev', 'wiki'),
    });
  });

  it('coordinatorPaths accepts an explicit baseDir', () => {
    expect(coordinatorPaths('prod', { TMPDIR: '/tmp' }, { baseDir: '/tmp/coral-root' })).toEqual({
      runDir: join('/tmp/coral-root', 'gen2', 'run'),
      socketPath: join('/tmp/coral-root', 'gen2', 'run', 'coordinator.sock'),
      infoFile: join('/tmp/coral-root', 'gen2', 'run', 'coordinator.json'),
      startupErrorFile: join('/tmp/coral-root', 'gen2', 'run', 'startup-error.json'),
      startupDiagnosticFile: join('/tmp/coral-root', 'gen2', 'run', 'startup-diagnostic.json'),
    });
  });

  it('exportsPaths accepts an explicit baseDir', () => {
    expect(exportsPaths('dev', { baseDir: '/tmp/coral-root' })).toEqual({
      jobsRoot: join('/tmp/coral-root', 'exports-dev', 'jobs'),
    });
  });

  it('enginePaths accepts an explicit baseDir and exposes per-name accessors', () => {
    const eq = enginePaths('prod', { baseDir: '/tmp/coral-root' });
    expect(eq.engineRoot).toBe(join('/tmp/coral-root', 'gen2', 'data', 'engines'));
    expect(eq.dataDir('vector')).toBe(join('/tmp/coral-root', 'gen2', 'data', 'engines', 'vector'));
    expect(eq.installLockPath('vector')).toBe(
      join('/tmp/coral-root', 'gen2', 'data', 'engines', '.locks', 'vector.lock'),
    );
  });

  it('projectsPaths accepts an explicit baseDir and slugifies the source into dataDir', () => {
    const prod = projectsPaths('prod', { baseDir: '/tmp/coral-root' });
    expect(prod.root).toBe(join('/tmp/coral-root', 'projects'));
    // `owner/repo` and `local/basename` sources collapse their slash into the dir slug.
    expect(prod.dataDir('owner/repo')).toBe(join('/tmp/coral-root', 'projects', 'owner-repo'));
    expect(prod.dataDir('local/my-project')).toBe(join('/tmp/coral-root', 'projects', 'local-my-project'));

    const dev = projectsPaths('dev', { baseDir: '/tmp/coral-root' });
    expect(dev.root).toBe(join('/tmp/coral-root', 'projects-dev'));
    expect(dev.dataDir('owner/repo')).toBe(join('/tmp/coral-root', 'projects-dev', 'owner-repo'));
  });
});
