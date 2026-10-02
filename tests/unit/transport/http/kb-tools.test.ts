import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import type { KbToolRuntime, KnowledgeBaseRuntime } from '#src/kb/runtime-contract.js';
import { handleKbRead, handleKbWikiCreate } from '#src/kb/tool-handlers.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { createEmptyGeneratedCommunityProjectionStore } from '#tests/fixtures/test-runtime.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const mockState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  createWiki: vi.fn(),
}));

vi.mock('#src/kb/ops/wiki/create.js', () => ({ createWiki: mockState.createWiki }));

const KB_ROOT = '/virtual/kb';

function createKbToolRuntime(): KnowledgeBaseRuntime {
  return {
    kb: {
      notePath: (slug: string) => `${KB_ROOT}/notes/${slug}.md`,
      wikiPath: (slug: string) => `${KB_ROOT}/wiki/${slug}.md`,
      sourcePath: (slug: string) => `${KB_ROOT}/sources/${slug}.md`,
      communityPath: (slug: string) => `${KB_ROOT}/communities/${slug}.md`,
      principlePath: (slug: string) => `${KB_ROOT}/principles/${slug}.md`,
      generatedCommunityProjectionStore: createEmptyGeneratedCommunityProjectionStore(),
    } as unknown as KnowledgeBaseRuntime['kb'],
    readDb: {} as KnowledgeBaseRuntime['readDb'],
    curateScheduler: {
      start: vi.fn(async () => {}),
      schedule: vi.fn(),
      scheduleDeferredCommit: vi.fn(),
      stop: vi.fn(async () => {}),
      isRunning: () => false,
    },
  };
}

const testContext: InvocationContext = {
  projectRoot: fixtureCanonicalWorkDir('/tmp/project'),
  pluginRoot: '/tmp/plugin',
  coralEnv: {},
  principal: testProjectPrincipal('/tmp/project'),
};

const testRuntime = {
  storage: {
    existsSync: (path: string) => mockState.files.has(path),
    readFileSync: (path: string, _encoding: 'utf-8') => {
      const content = mockState.files.get(path);
      if (content !== undefined) {
        return content;
      }

      const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({
      size: 0,
      mtimeMs: 0,
      isDirectory: () => false,
      isFile: () => true,
    })),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  ids: {
    uuid: () => 'test-uuid',
  },
  paths: {
    // Identity resolver: the per-project data dir under test is the project root
    // itself, so `memoDir(projectData)` keeps matching the fixture memo paths.
    projectData: (projectRoot: string) => projectRoot,
    projectSource: (projectRoot: string) => projectRoot,
  },
} as unknown as KbToolRuntime;

function setMockFile(path: string, content: string): void {
  mockState.files.set(path, content);
}

describe('kb-tools', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockState.files.clear();
  });

  it('dispatches explicit community selectors through the shared read contract', () => {
    const kbRuntime = createKbToolRuntime();
    setMockFile(
      kbRuntime.kb.communityPath('graph-rag'),
      `---
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-24T12:00:00.000Z
level: 1
---
# Graph Rag

## Members
- note:contract-first-design
`,
    );

    expect(handleKbRead({ note: 'communities:graph-rag' }, testContext, testRuntime, kbRuntime)).toMatchObject({
      ok: true,
      data: {
        kind: 'community',
        note: 'graph-rag',
      },
    });
  });

  it('handleKbWikiCreate calls createWiki and schedules a deferred commit', async () => {
    const kbRuntime = createKbToolRuntime();
    mockState.createWiki.mockResolvedValue({ slug: 'living-knowledge', path: '/virtual/kb/wiki/living-knowledge.md' });

    const result = await handleKbWikiCreate({ slug: 'living-knowledge' }, kbRuntime);

    expect(mockState.createWiki).toHaveBeenCalledWith(kbRuntime.kb, {
      slug: 'living-knowledge',
    });
    expect(kbRuntime.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      data: { slug: 'living-knowledge', path: '/virtual/kb/wiki/living-knowledge.md' },
    });
  });
});
