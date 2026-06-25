import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createKbChildReadHandler, createKbChildReadService } from '#src/coordinator/kb-child/read-handler.js';
import { INDEX_FILE } from '#src/kb/corpus/index-store.js';
import { communityPathFromName, kbRuntimeDir, memoDir, notePathFromName } from '#src/kb/paths.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function writeNote(runtime: SimulationRuntime, slug: string): void {
  const path = notePathFromName(slug, runtime.paths.coral.corpus.kbRoot);
  runtime.storage.mkdirSync(dirname(path), { recursive: true });
  runtime.storage.writeFileSync(
    path,
    [
      '---',
      'tags: [alpha]',
      'principles: []',
      'source: []',
      'createdAt: 2026-01-01T00:00:00.000Z',
      'updatedAt: 2026-01-01T00:00:00.000Z',
      '---',
      '# Alpha Note',
      '',
      'Body from the child read handler.',
      '',
    ].join('\n'),
  );
}

function writeMemo(runtime: SimulationRuntime, projectRoot: string): void {
  const dir = memoDir(runtime.paths.projectData(projectRoot));
  runtime.storage.mkdirSync(dir, { recursive: true });
  runtime.storage.writeFileSync(
    join(dir, '20260101-000000-alpha.md'),
    ['---', 'source: alpha-note', 'owner: kang', '---', 'memo body for child handler', ''].join('\n'),
  );
}

function writeCommunity(runtime: SimulationRuntime, slug: string): void {
  const path = communityPathFromName(slug, runtime.paths.coral.corpus.kbRoot);
  runtime.storage.mkdirSync(dirname(path), { recursive: true });
  runtime.storage.writeFileSync(
    path,
    [
      '---',
      'createdAt: 2026-01-01T00:00:00.000Z',
      'updatedAt: 2026-01-01T00:00:00.000Z',
      'level: 0',
      '---',
      '# Alpha Community',
      '',
      '## Members',
      '',
    ].join('\n'),
  );
}

describe('KB child read handler', () => {
  it('reads note entries from the child read-model runtime', async () => {
    const runtime = new SimulationRuntime();
    writeNote(runtime, 'alpha-note');
    const read = createKbChildReadHandler({ pluginRoot: '/plugin', runtime });

    const result = await read({ method: 'readNote', slug: 'alpha-note' });

    expect(result).toMatchObject({
      ok: true,
      data: {
        kind: 'note',
        note: 'alpha-note',
        title: 'Alpha Note',
        content: 'Body from the child read handler.',
      },
    });
  });

  it('reports child read runtime health after first successful runtime use', async () => {
    const runtime = new SimulationRuntime();
    writeNote(runtime, 'alpha-note');
    const service = createKbChildReadService({ pluginRoot: '/plugin', runtime, now: () => 1234 });

    expect(service.health()).toEqual({ phase: 'not_initialized' });

    await expect(service.read({ method: 'readNote', slug: 'alpha-note' })).resolves.toMatchObject({ ok: true });

    expect(service.health()).toEqual({ phase: 'ready', initializedAt: 1234 });
  });

  it('warms the child read runtime without running a read request', async () => {
    const runtime = new SimulationRuntime();
    const service = createKbChildReadService({ pluginRoot: '/plugin', runtime, now: () => 1234 });

    await expect(service.warmup()).resolves.toEqual({ phase: 'ready', initializedAt: 1234 });
    expect(service.health()).toEqual({ phase: 'ready', initializedAt: 1234 });
  });

  it('reports child read runtime failures as KB tool errors and health diagnostics', async () => {
    const runtime = new SimulationRuntime();
    writeNote(runtime, 'alpha-note');
    vi.spyOn(runtime.storage, 'existsSync').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const service = createKbChildReadService({ pluginRoot: '/plugin', runtime, now: () => 1234 });

    const result = await service.read({ method: 'readNote', slug: 'alpha-note' });

    expect(result).toMatchObject({
      ok: false,
      code: 'kb_error',
      message: 'storage unavailable',
    });
    expect(service.health()).toEqual({
      phase: 'failed',
      initializedAt: 1234,
      lastError: 'storage unavailable',
    });
  });

  it('validates read slugs before resolving child read-model paths', async () => {
    const runtime = new SimulationRuntime();
    const read = createKbChildReadHandler({ pluginRoot: '/plugin', runtime });

    const result = await read({ method: 'readNote', slug: '../alpha-note' });

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('uses project context for memo list reads', async () => {
    const runtime = new SimulationRuntime();
    const projectRoot = '/workspace/project-a';
    writeMemo(runtime, projectRoot);
    const read = createKbChildReadHandler({ pluginRoot: '/plugin', runtime });

    const missingContext = await read({ method: 'listMemos', args: {} });
    expect(missingContext).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });

    const result = await read({
      method: 'listMemos',
      args: { owner: 'kang' },
      ctx: { projectRoot, pluginRoot: '/plugin' },
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        memos: [{ filename: '20260101-000000-alpha.md', owner: 'kang' }],
      },
    });
  });

  it('reads community summary surfaces from the child read runtime', async () => {
    const runtime = new SimulationRuntime();
    writeCommunity(runtime, 'alpha-community');
    const indexPath = join(kbRuntimeDir(runtime.flavor), INDEX_FILE);
    runtime.storage.mkdirSync(dirname(indexPath), { recursive: true });
    runtime.storage.writeFileSync(indexPath, '{not-json');
    const read = createKbChildReadHandler({ pluginRoot: '/plugin', runtime });

    await expect(read({ method: 'listStaleCommunities' })).resolves.toEqual({
      ok: true,
      data: [{ slug: 'alpha-community', level: 0 }],
    });
    expect(runtime.storage.existsSync(indexPath)).toBe(true);

    await expect(read({ method: 'readCommunitySummaryInput', slug: 'alpha-community' })).resolves.toMatchObject({
      ok: true,
      data: {
        slug: 'alpha-community',
        level: 0,
        kind: 'leaf',
      },
    });

    await expect(read({ method: 'readCommunitySummaryInput', slug: 'missing-community' })).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
