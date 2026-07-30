import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const searchMock = vi.hoisted(() => ({
  searchKb: vi.fn(async () => ({
    results: [
      {
        note: 'ko-contract',
        kind: 'note' as const,
        title: 'KO Contract',
        matchedBy: ['content' as const],
        tags: ['ko'],
        principles: [],
        evidence: [],
        snippet: '계약 검색 결과',
      },
    ],
    mode: 'text' as const,
    retrievalDiagnostics: [],
  })),
}));

vi.mock('#src/kb/ops/search.js', () => ({
  searchKb: searchMock.searchKb,
}));

import { createKbDaemonRequestService } from '#src/kb-daemon/request-service.js';
import { INDEX_FILE } from '#src/kb/corpus/index/store.js';
import { GeneratedCommunityProjectionStore } from '#src/kb/curate/community/generated-projection-store.js';
import { memoDir, notePathFromName, wikiPathFromName } from '#src/kb/paths.js';
import type { KnowledgeBaseRuntime } from '#src/kb/runtime-contract.js';
import type { KbQueryRuntime } from '#src/read-model/kb-query-runtime.js';
import type { PrincipalWire } from '#src/security/principal-wire.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

type WithKbCallback<T> = (state: { kbRuntime: KnowledgeBaseRuntime; runtime: KbQueryRuntime }) => Promise<T> | T;

function createSearchKbRuntime(kb: unknown): KnowledgeBaseRuntime {
  return {
    kb: kb as KnowledgeBaseRuntime['kb'],
    readDb: {} as KnowledgeBaseRuntime['readDb'],
    curateScheduler: {} as KnowledgeBaseRuntime['curateScheduler'],
  };
}

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

afterEach(() => {
  searchMock.searchKb.mockClear();
});

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

function writeGeneratedCommunity(runtime: SimulationRuntime, slug: string): void {
  const runtimeDir = runtime.paths.coral.kbRuntime.root;
  const store = new GeneratedCommunityProjectionStore({
    runtimeDir,
    storage: runtime.storage,
    ids: runtime.ids,
    time: runtime.time,
  });
  const snapshot = {
    snapshotId: 'daemon-summary-snapshot',
    contentSeq: 0,
    metadataSeq: 0,
    contentManifestHash: 'content',
    metadataManifestHash: 'metadata',
  };
  const staged = store.stageGeneration({
    snapshot,
    topologyHash: 'daemon-summary-topology',
    documents: [
      {
        slug,
        title: 'Alpha Community',
        level: 0,
        members: [],
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        content: [
          '---',
          'coralGeneratedCommunity: true',
          'createdAt: 2026-01-01',
          'updatedAt: 2026-01-01',
          'level: 0',
          '---',
          '# Alpha Community',
          '',
          '## Members',
          '',
        ].join('\n'),
      },
    ],
  });
  store.adoptStagedGeneration(staged, snapshot);
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

  it('serves kb search through the ready write runtime so ko/Kiwi results are not read-side fallbacks', async () => {
    const runtime = new SimulationRuntime();
    const writeKb = { marker: 'write-runtime-kb' };
    const kbRuntime = createSearchKbRuntime(writeKb);
    const withKb = vi.fn(async (run: WithKbCallback<unknown>) => run({ kbRuntime, runtime }));
    const writeRuntime = {
      withKb: withKb as <T>(run: WithKbCallback<T>) => Promise<T>,
      warmSearchRuntime: vi.fn(),
      searchReadiness: vi.fn(() => ({ ready: true as const })),
      createSource: vi.fn(async () => {
        throw new Error('source import should not be called');
      }),
      reindex: vi.fn(async () => {
        throw new Error('reindex should not be called');
      }),
      health: () => ({ phase: 'ready' as const, initializedAt: 1 }),
    };
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, writeRuntime });

    const result = await service.read({
      method: 'readSearch',
      args: { query: '계약', top_k: 3, scope: 'all' },
      ctx: daemonCtx(),
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        results: [expect.objectContaining({ note: 'ko-contract' })],
      },
    });
    expect(writeRuntime.warmSearchRuntime).toHaveBeenCalledTimes(1);
    expect(withKb).toHaveBeenCalledTimes(1);
    expect(searchMock.searchKb).toHaveBeenCalledWith(writeKb, '계약', 3, 'all', 'auto', undefined);
  });

  it.each([
    ['invalid scope', { query: '계약', scope: 'everything' }],
    ['invalid mode', { query: '계약', mode: 'semantic' }],
    ['negative top_k', { query: '계약', top_k: -1 }],
  ])('rejects kb search with %s', async (_label, args) => {
    const runtime = new SimulationRuntime();
    const writeRuntime = {
      withKb: vi.fn(async () => {
        throw new Error('write runtime search should not run for invalid search input');
      }),
      warmSearchRuntime: vi.fn(),
      searchReadiness: vi.fn(() => ({ ready: true as const })),
      createSource: vi.fn(async () => {
        throw new Error('source import should not be called');
      }),
      reindex: vi.fn(async () => {
        throw new Error('reindex should not be called');
      }),
      health: () => ({ phase: 'ready' as const, initializedAt: 1 }),
    };
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, writeRuntime });

    await expect(
      service.read({
        method: 'readSearch',
        args,
        ctx: daemonCtx(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    expect(writeRuntime.warmSearchRuntime).not.toHaveBeenCalled();
    expect(writeRuntime.withKb).not.toHaveBeenCalled();
    expect(searchMock.searchKb).not.toHaveBeenCalled();
  });

  it('makes served search reachable in a read-only session after daemon warmup', async () => {
    const runtime = new SimulationRuntime();
    let ready = false;
    const kbRuntime = createSearchKbRuntime({});
    const withKb = vi.fn(async (run: WithKbCallback<unknown>) => run({ kbRuntime, runtime }));
    const writeRuntime = {
      withKb: withKb as <T>(run: WithKbCallback<T>) => Promise<T>,
      warmSearchRuntime: vi.fn(() => {
        ready = true;
      }),
      searchReadiness: vi.fn(() =>
        ready
          ? { ready: true as const }
          : {
              ready: false as const,
              reason: 'write_runtime_initializing',
              message: 'KB search runtime is still warming.',
            },
      ),
      createSource: vi.fn(async () => {
        throw new Error('source import should not be called');
      }),
      reindex: vi.fn(async () => {
        throw new Error('reindex should not be called');
      }),
      health: () => ({ phase: ready ? ('ready' as const) : ('not_initialized' as const) }),
    };
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, writeRuntime });

    await expect(service.warmup()).resolves.toMatchObject({ phase: 'ready' });
    await expect(
      service.read({
        method: 'readSearch',
        args: { query: '계약' },
        ctx: daemonCtx(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { results: [expect.objectContaining({ note: 'ko-contract' })] },
    });
    expect(writeRuntime.warmSearchRuntime).toHaveBeenCalled();
    expect(writeRuntime.withKb).toHaveBeenCalledTimes(1);
  });

  it('fails fast when the Kiwi analyzer was evicted instead of timing out or returning silent zero hits', async () => {
    const runtime = new SimulationRuntime();
    const writeRuntime = {
      withKb: vi.fn(async () => {
        throw new Error('write runtime search should not run while analyzer is evicted');
      }),
      warmSearchRuntime: vi.fn(),
      searchReadiness: vi.fn(() => ({
        ready: false as const,
        reason: 'kiwi_analyzer_evicted',
        message: 'KB search analyzer is warming.',
      })),
      createSource: vi.fn(async () => {
        throw new Error('source import should not be called');
      }),
      reindex: vi.fn(async () => {
        throw new Error('reindex should not be called');
      }),
      health: () => ({ phase: 'ready' as const, initializedAt: 1 }),
    };
    const service = createKbDaemonRequestService({ pluginRoot: '/plugin', runtime, writeRuntime });

    const startedAt = Date.now();
    const result = await service.read({
      method: 'readSearch',
      args: { query: '계약' },
      ctx: daemonCtx(),
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result).toMatchObject({
      ok: false,
      code: 'kb_search_runtime_not_ready',
      message: 'KB search analyzer is warming.',
      detail: { reason: 'kiwi_analyzer_evicted' },
    });
    expect(writeRuntime.warmSearchRuntime).toHaveBeenCalledTimes(1);
    expect(writeRuntime.withKb).not.toHaveBeenCalled();
    expect(searchMock.searchKb).not.toHaveBeenCalled();
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
    writeGeneratedCommunity(runtime, 'alpha-community');
    const indexPath = join(runtime.paths.coral.kbRuntime.root, INDEX_FILE);
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
