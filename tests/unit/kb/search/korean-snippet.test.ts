import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { KiwiAnalyzerManager } from '#src/engines/kiwi/analyzer-manager.js';
import type { KiwiAnalyzer } from '#src/engines/kiwi/loader.js';
import { searchKb } from '#src/kb/ops/search.js';
import { noteEntryId, type KbResult } from '#src/kb/entry-types.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { bindOramaFtsForTest } from '#tests/unit/kb/expansion-test-helpers.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';
import { applyBoundCorpusConsumerForTest, createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { installedKiwiArtifactState } from '#tests/helpers/kiwi-artifact-state.js';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-korean-snippet-'));
  tempRoots.push(root);
  return root;
}

function withKoEnv(runtime: Runtime): Runtime {
  return {
    ...runtime,
    env: {
      ...runtime.env,
      get: (key) => (key === 'CORAL_KB_EXTRA_LANGS' ? 'ko' : runtime.env.get(key)),
      fullSnapshot: () => ({ ...runtime.env.fullSnapshot(), CORAL_KB_EXTRA_LANGS: 'ko' }),
      coralSnapshot: () => ({ ...runtime.env.coralSnapshot(), CORAL_KB_EXTRA_LANGS: 'ko' }),
    },
  };
}

function createLemmaKiwiAnalyzer(): KiwiAnalyzer {
  return {
    identity: {
      engine: 'kiwi',
      kiwiNlpVersion: '0.23.0',
      modelVersion: '0.23.0',
      modelType: 'cong-global',
    },
    kiwi: {} as KiwiAnalyzer['kiwi'],
    tokenize: () => [] as unknown as ReturnType<KiwiAnalyzer['tokenize']>,
    tokens(text: string): readonly string[] {
      if (text === '찾습니다' || text === '찾다') {
        return ['찾다'];
      }
      return [text];
    },
    async dispose(): Promise<void> {},
  };
}

function createLemmaKiwiManager(): KiwiAnalyzerManager {
  return new KiwiAnalyzerManager({
    inspectArtifact: () => installedKiwiArtifactState(),
    loadAnalyzer: async () => createLemmaKiwiAnalyzer(),
    logger: () => {},
  });
}

function writeNote(kb: KbRuntime, slug: string, title: string, body: string, tags: readonly string[] = []): void {
  mkdirSync(kb.notesDir(), { recursive: true });
  writeFileSync(
    kb.notePath(slug),
    [
      '---',
      `tags: [${tags.join(', ')}]`,
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-04-01T00:00:00.000Z',
      'updatedAt: 2026-04-01T00:00:00.000Z',
      'entrySeq: 1',
      '---',
      `# ${title}`,
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
  kb.writeIndex({
    entries: {
      [noteEntryId(slug)]: buildNoteIndexEntry({
        slug,
        title,
        tags: [...tags],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        body,
        entrySeq: 1,
      }),
    },
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', 'seed Korean snippet note');
}

function resultFor(results: readonly KbResult[], note: string): KbResult {
  const result = results.find((candidate) => candidate.note === note);
  if (result === undefined) {
    throw new Error(`Missing result for ${note}`);
  }
  return result;
}

describe('Korean body-only snippets', () => {
  it('returns matchedBy content and a non-empty snippet for a Korean body-only hit', async () => {
    const root = allocateRoot();
    const db = createKbTestDb(join(root, '.runtime'));
    const { kb } = createKbTestRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db,
    });
    bindOramaFtsForTest(kb);
    writeNote(kb, 'neutral-title', 'Neutral Title', '본문에서만 검색어를 찾습니다.');

    await applyBoundCorpusConsumerForTest(kb, db);

    const response = await searchKb(kb, '검색어', 10, 'all', 'text');
    const match = resultFor(response.results, 'neutral-title');

    expect(match.matchedBy).toContain('content');
    expect(match.matchedBy).not.toContain('title');
    expect(match.snippet).toContain('검색어');
  });

  it('uses leased Kiwi tokens for Korean matchedBy and snippet anchoring', async () => {
    const root = allocateRoot();
    const db = createKbTestDb(join(root, '.runtime'));
    const kiwiRuntime = withKoEnv(createRealRuntime('prod'));
    const { kb } = createKbTestRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db,
      runtime: kiwiRuntime,
    });
    const manager = createLemmaKiwiManager();
    bindOramaFtsForTest(kb, { analyzerManager: manager, kiwiRuntime });
    writeNote(kb, 'kiwi-lemma', 'Neutral Title', '본문에서만 찾습니다.', ['찾습니다']);

    await applyBoundCorpusConsumerForTest(kb, db);

    const response = await searchKb(kb, '찾다', 10, 'all', 'text');
    const match = resultFor(response.results, 'kiwi-lemma');

    expect(match.matchedBy).toEqual(expect.arrayContaining(['tag', 'content']));
    expect(match.matchedBy).not.toContain('title');
    expect(match.snippet).toContain('찾습니다');
    await manager.close();
  });
});
