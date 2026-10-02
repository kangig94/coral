import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeBaseRuntime } from '#src/kb/runtime-contract.js';
import { handleKbWikiCreate } from '#src/kb/tool-handlers.js';
import { createEmptyGeneratedCommunityProjectionStore } from '#tests/fixtures/test-runtime.js';

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

describe('kb-tools', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockState.files.clear();
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
