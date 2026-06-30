import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createKbDaemonRequestService } from '#src/kb-daemon/request-service.js';
import { INDEX_FILE } from '#src/kb/corpus/index/store.js';
import { communityPathFromName, kbRuntimeDir, memoDir, notePathFromName, wikiPathFromName } from '#src/kb/paths.js';
import type { PrincipalWire } from '#src/security/principal-wire.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function principalWire(projectRoot: string): PrincipalWire {
  return {
    subject: 'operator' as const,
    binding: { kind: 'project' as const, root: projectRoot },
  };
}

function daemonCtx(projectRoot = '/workspace/project-a', principal: PrincipalWire = principalWire(projectRoot)) {
  return { projectRoot, pluginRoot: '/plugin', principal };
}

const deniedSourceImportPrincipals: Array<[string, PrincipalWire]> = [
  [
    'agent unbound principal',
    {
      subject: 'agent',
      binding: { kind: 'unbound' },
    },
  ],
  [
    'attenuated operator without source import',
    {
      subject: 'operator',
      binding: { kind: 'project', root: '/workspace/project-a' },
      attenuatedCaps: ['liveness', 'kb:read', 'kb:write'],
    },
  ],
];

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
      'Body from the daemon request service.',
      '',
    ].join('\n'),
  );
}

function writeMemo(runtime: SimulationRuntime, projectRoot: string): void {
  const dir = memoDir(runtime.paths.projectData(projectRoot));
  runtime.storage.mkdirSync(dir, { recursive: true });
  runtime.storage.writeFileSync(
    join(dir, '20260101-000000-alpha.md'),
    ['---', 'source: alpha-note', 'owner: kang', '---', 'memo body for daemon handler', ''].join('\n'),
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

function writeWiki(runtime: SimulationRuntime, slug: string): void {
  const path = wikiPathFromName(slug, runtime.paths.coral.corpus.kbRoot);
  runtime.storage.mkdirSync(dirname(path), { recursive: true });
  runtime.storage.writeFileSync(
    path,
    [
      '---',
      'tags: [wake]',
      'createdAt: 2026-05-04T00:00:00.000Z',
      'updatedAt: 2026-05-04T01:00:00.000Z',
      '---',
      `# ${slug}`,
      '',
      '## Understanding',
      '',
      'Daemon wake-up understanding.',
      '',
      '## Knowledge',
      '',
    ].join('\n'),
  );
}

describe('KB daemon request service', () => {
  it('reads note entries from the daemon request runtime', async () => {
    const runtime = new SimulationRuntime();
    writeNote(runtime, 'alpha-note');
    const read = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime }).read;

    const result = await read({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });

    expect(result).toMatchObject({
      ok: true,
      data: {
        kind: 'note',
        note: 'alpha-note',
        title: 'Alpha Note',
        content: 'Body from the daemon request service.',
      },
    });
  });

  it('reports daemon request runtime health after first successful runtime use', async () => {
    const runtime = new SimulationRuntime();
    writeNote(runtime, 'alpha-note');
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, now: () => 1234 });

    expect(service.health()).toEqual({ phase: 'not_initialized' });

    await expect(service.read({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() })).resolves.toMatchObject({
      ok: true,
    });

    expect(service.health()).toEqual({ phase: 'ready', initializedAt: 1234 });
  });

  it('warms the daemon request runtime without running a read request', async () => {
    const runtime = new SimulationRuntime();
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, now: () => 1234 });

    await expect(service.warmup()).resolves.toEqual({ phase: 'ready', initializedAt: 1234 });
    expect(service.health()).toEqual({ phase: 'ready', initializedAt: 1234 });
  });

  it('reports daemon request runtime failures as KB tool errors and health diagnostics', async () => {
    const runtime = new SimulationRuntime();
    writeNote(runtime, 'alpha-note');
    vi.spyOn(runtime.storage, 'existsSync').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, now: () => 1234 });

    const result = await service.read({ method: 'readNote', slug: 'alpha-note', ctx: daemonCtx() });

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

  it('validates read slugs before resolving daemon read-model paths', async () => {
    const runtime = new SimulationRuntime();
    const read = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime }).read;

    const result = await read({ method: 'readNote', slug: '../alpha-note', ctx: daemonCtx() });

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it.each([
    ['missing ctx', undefined],
    ['missing principal', { projectRoot: '/workspace/project-a' }],
    ['unknown subject', { projectRoot: '/workspace/project-a', principal: { subject: 'admin' } }],
    [
      'bad binding',
      { projectRoot: '/workspace/project-a', principal: { subject: 'operator', binding: { kind: 'workspace' } } },
    ],
    [
      'non-array attenuation',
      {
        projectRoot: '/workspace/project-a',
        principal: {
          subject: 'operator',
          binding: { kind: 'project', root: '/workspace/project-a' },
          attenuatedCaps: 'expansion:manage',
        },
      },
    ],
  ])('rejects read requests with %s instead of elevating', async (_label, ctx) => {
    const runtime = new SimulationRuntime();
    writeNote(runtime, 'alpha-note');
    const read = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime }).read;

    const result = await read({ method: 'readNote', slug: 'alpha-note', ctx } as never);

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });

  it('uses project context for memo list reads', async () => {
    const runtime = new SimulationRuntime();
    const projectRoot = '/workspace/project-a';
    writeMemo(runtime, projectRoot);
    const read = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime }).read;

    const missingContext = await read({
      method: 'listMemos',
      args: {},
      ctx: { principal: principalWire(projectRoot) },
    });
    expect(missingContext).toMatchObject({
      ok: false,
      code: 'unauthorized',
    });

    const result = await read({
      method: 'listMemos',
      args: { owner: 'kang' },
      ctx: daemonCtx(projectRoot),
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        memos: [{ filename: '20260101-000000-alpha.md', owner: 'kang' }],
      },
    });
  });

  it('creates memos through the daemon request service', async () => {
    const runtime = new SimulationRuntime();
    const projectRoot = '/workspace/project-a';
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime });

    const missingContext = await service.mutate({
      method: 'createMemo',
      args: { topic: 'alpha', content: 'daemon memo body', owner: 'kang' },
    } as never);
    expect(missingContext).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });

    await expect(
      service.mutate({
        method: 'createMemo',
        args: { topic: 'alpha', content: 'daemon memo body', owner: 'kang' },
        ctx: {
          projectRoot,
          pluginRoot: '/plugin',
          principal: principalWire(projectRoot),
          coralEnv: { CORAL_JOB_ID: 'job-1' },
        },
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      service.read({
        method: 'listMemos',
        args: { owner: 'kang' },
        ctx: daemonCtx(projectRoot),
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        memos: [expect.objectContaining({ owner: 'kang' })],
      },
    });
  });

  it('deletes memos through the daemon request service', async () => {
    const runtime = new SimulationRuntime();
    const projectRoot = '/workspace/project-a';
    writeMemo(runtime, projectRoot);
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime });

    await expect(
      service.mutate({
        method: 'deleteMemos',
        args: { pattern: '*alpha.md', owner: 'kang' },
        ctx: daemonCtx(projectRoot),
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      service.read({
        method: 'listMemos',
        args: { owner: 'kang' },
        ctx: daemonCtx(projectRoot),
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { memos: [] },
    });
  });

  it('returns kb_unavailable for write-backed mutations after the write runtime is disposed', async () => {
    const runtime = new SimulationRuntime();
    const writeRuntime = {
      withKb: vi.fn(async () => {
        throw new Error('write runtime should not be called');
      }),
      createSource: vi.fn(async () => {
        throw new Error('source import should not be called');
      }),
      reindex: vi.fn(async () => {
        throw new Error('reindex should not be called');
      }),
      health: () => ({ phase: 'disposed' as const }),
    };
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, writeRuntime });

    await expect(
      service.mutate({
        method: 'updateNote',
        args: { note: 'alpha-note' },
        ctx: {
          projectRoot: '/workspace/project-a',
          pluginRoot: '/plugin',
          principal: principalWire('/workspace/project-a'),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'kb_unavailable',
      message: expect.stringContaining('disposed'),
    });
    expect(writeRuntime.withKb).not.toHaveBeenCalled();
  });

  it('fails kb search fast and starts write-runtime warmup when search is still cold', async () => {
    const runtime = new SimulationRuntime();
    const writeRuntime = {
      withKb: vi.fn(async () => {
        throw new Error('write runtime search should not run while cold');
      }),
      warmSearchRuntime: vi.fn(),
      searchReadiness: vi.fn(() => ({
        ready: false as const,
        reason: 'write_runtime_initializing',
        message: 'KB search runtime is still warming.',
      })),
      createSource: vi.fn(async () => {
        throw new Error('source import should not be called');
      }),
      reindex: vi.fn(async () => {
        throw new Error('reindex should not be called');
      }),
      health: () => ({ phase: 'not_initialized' as const }),
    };
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, writeRuntime });

    const result = await service.read({
      method: 'readSearch',
      args: { query: '계약' },
      ctx: daemonCtx(),
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'kb_search_runtime_not_ready',
      message: 'KB search runtime is still warming.',
      detail: { reason: 'write_runtime_initializing' },
    });
    expect(writeRuntime.warmSearchRuntime).toHaveBeenCalledTimes(1);
    expect(writeRuntime.withKb).not.toHaveBeenCalled();
  });

  it.each(deniedSourceImportPrincipals)(
    'denies createSource for %s before touching write runtime services',
    async (_label, principal) => {
      const runtime = new SimulationRuntime();
      const projectRoot = '/workspace/project-a';
      const insidePath = join(projectRoot, 'inside.md');
      runtime.storage.mkdirSync(projectRoot, { recursive: true });
      runtime.storage.writeFileSync(insidePath, '# Inside\n');
      const withKb = vi.fn(async () => {
        throw new Error('withKb should not be called');
      });
      const createSource = vi.fn(async () => {
        throw new Error('source import should not be called');
      });
      const service = createKbDaemonRequestService({
        pluginRoot: '/plugin',
        runtime,
        writeRuntime: {
          withKb,
          createSource,
          reindex: vi.fn(async () => {
            throw new Error('reindex should not be called');
          }),
          health: () => ({ phase: 'ready' as const, initializedAt: 1 }),
        },
      });

      const result = await service.mutate({
        method: 'createSource',
        args: { filePath: insidePath, readiness: 'base-search', async: false },
        ctx: daemonCtx(projectRoot, principal),
      });

      expect(result).toMatchObject({
        ok: false,
        code: 'unauthorized',
      });
      expect(createSource).not.toHaveBeenCalled();
      expect(withKb).not.toHaveBeenCalled();
    },
  );

  it('generates wake-up packets from the daemon request runtime', async () => {
    const runtime = new SimulationRuntime();
    writeWiki(runtime, 'kangig94-coral');
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime });

    await expect(
      service.read({ method: 'wakeUp', args: { project: 'kangig94-coral' }, ctx: daemonCtx() }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        content: expect.stringContaining('Daemon wake-up understanding.'),
      },
    });
  });

  it('reads community summary surfaces from the daemon request runtime', async () => {
    const runtime = new SimulationRuntime();
    writeCommunity(runtime, 'alpha-community');
    const indexPath = join(kbRuntimeDir(runtime.flavor), INDEX_FILE);
    runtime.storage.mkdirSync(dirname(indexPath), { recursive: true });
    runtime.storage.writeFileSync(indexPath, '{not-json');
    const read = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime }).read;

    await expect(read({ method: 'listStaleCommunities', ctx: daemonCtx() })).resolves.toEqual({
      ok: true,
      data: [{ slug: 'alpha-community', level: 0 }],
    });
    expect(runtime.storage.existsSync(indexPath)).toBe(true);

    await expect(
      read({ method: 'readCommunitySummaryInput', slug: 'alpha-community', ctx: daemonCtx() }),
    ).resolves.toMatchObject({
      ok: true,
      data: {
        slug: 'alpha-community',
        level: 0,
        kind: 'leaf',
      },
    });

    await expect(
      read({ method: 'readCommunitySummaryInput', slug: 'missing-community', ctx: daemonCtx() }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });
});
