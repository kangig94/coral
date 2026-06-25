import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createKbChildReadHandler } from '#src/coordinator/kb-child/read-handler.js';
import { memoDir, notePathFromName } from '#src/kb/paths.js';
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

  it('reports full-runtime-only read methods as unavailable', async () => {
    const runtime = new SimulationRuntime();
    const read = createKbChildReadHandler({ pluginRoot: '/plugin', runtime });

    await expect(read({ method: 'listStaleCommunities' })).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
      detail: { reason: 'kb_child_read_not_supported' },
    });
  });
});
