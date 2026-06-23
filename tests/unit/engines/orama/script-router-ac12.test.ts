import { insert, search as oramaSearch } from '@orama/orama';
import { describe, expect, it } from 'vitest';

import { KiwiAnalyzerManager } from '#src/engines/kiwi/analyzer-manager.js';
import type { KiwiAnalyzer } from '#src/engines/kiwi/loader.js';
import type { KiwiModelArtifactState } from '#src/engines/kiwi/model-artifact.js';
import {
  createOramaDb,
  createOramaTokenizer,
  normalizeOramaTerm,
  tokenizeQuery,
  type KbOramaDocument,
} from '#src/engines/orama/document-builder.js';
import { buildOramaSearchChannelFields } from '#src/engines/orama/search-channels.js';
import type { Runtime } from '#src/runtime/ports.js';

function createRuntime(): Runtime {
  return {
    time: {
      now: () => 1_000,
      setTimeout: () => ({ active: true }),
      clearTimeout: () => {},
      setInterval: () => ({ active: true }),
      clearInterval: () => {},
      sleep: async () => {},
    },
    paths: {
      coral: {
        engine: {
          dataDir: (name: string) => `/tmp/coral/engines/${name}`,
        },
      },
    },
  } as unknown as Runtime;
}

function installedKiwiState(): KiwiModelArtifactState {
  return {
    targetDir: '/tmp/kiwi',
    manifestPath: '/tmp/kiwi/manifest.json',
    installed: true,
    missingFiles: [],
    manifest: {
      packageId: 'kiwi',
      kiwiNlpVersion: '0.23.0',
      modelVersion: '0.23.0',
      modelType: 'cong-global',
      sourceUrl: 'https://example.invalid/kiwi.tgz',
      archiveSha256: 'digest',
      archiveSizeBytes: 1,
      files: [],
      installedAt: '2026-06-19T00:00:00.000Z',
    },
  };
}

function createKiwiAnalyzer(): KiwiAnalyzer {
  return {
    identity: {
      engine: 'kiwi',
      kiwiNlpVersion: '0.23.0',
      modelVersion: '0.23.0',
      modelType: 'cong-global',
    },
    kiwi: {} as KiwiAnalyzer['kiwi'],
    tokenize: () => [],
    tokens(text: string): readonly string[] {
      return [`kiwi_${text}`];
    },
    async dispose(): Promise<void> {},
  };
}

function createManager(): KiwiAnalyzerManager {
  return new KiwiAnalyzerManager({
    inspectModelArtifact: () => installedKiwiState(),
    loadAnalyzer: async () => createKiwiAnalyzer(),
    logger: () => {},
  });
}

function mixedScriptDocument(): KbOramaDocument {
  const slug = 'mixed-script-router';
  const title = 'Mixed Script Router';
  const body = '검색 hello 검색API React훅 v2검색';
  const tags: string[] = [];
  const principles: string[] = [];
  return {
    id: 'note:mixed-script-router',
    entryId: 'note:mixed-script-router',
    slug,
    kind: 'note',
    freshness: 'fresh',
    title,
    body,
    tags,
    principles,
    ...buildOramaSearchChannelFields({ slug, title, body, tags, principles }),
    contentHash: 'content',
    metadataHash: 'metadata',
  };
}

describe('Orama AC12 script router', () => {
  it('routes mixed-script Hangul runs to the leased Kiwi analyzer and other runs to Intl', async () => {
    const runtime = createRuntime();
    const manager = createManager();
    const tokenizer = createOramaTokenizer({
      currentKiwiAnalyzer: () => manager.currentAnalyzer(),
    });

    expect(tokenizeQuery(normalizeOramaTerm('검색API'), tokenizer)).toEqual(['검색', 'api']);

    await manager.withAnalyzerLease(runtime, ['ko'], () => {
      expect(tokenizeQuery(normalizeOramaTerm('검색 hello'), tokenizer)).toEqual(['kiwi_검색', 'hello']);
      expect(tokenizeQuery(normalizeOramaTerm('검색API'), tokenizer)).toEqual(['kiwi_검색', 'api']);
      expect(tokenizeQuery(normalizeOramaTerm('React훅'), tokenizer)).toEqual(['react', 'kiwi_훅']);
      expect(tokenizeQuery(normalizeOramaTerm('v2검색'), tokenizer)).toEqual(['v2', 'kiwi_검색']);
    });
  });

  it('uses one Kiwi-routed Orama index and search path for mixed-script documents', async () => {
    const runtime = createRuntime();
    const manager = createManager();
    const { db } = await createOramaDb({
      currentKiwiAnalyzer: () => manager.currentAnalyzer(),
    });

    await manager.withAnalyzerLease(runtime, ['ko'], async () => {
      await insert(db, mixedScriptDocument());

      for (const query of ['검색 hello', '검색API', 'React훅', 'v2검색']) {
        const result = await oramaSearch(db, {
          term: normalizeOramaTerm(query),
          properties: ['body'],
          limit: 10,
        });
        expect(
          result.hits.map((hit) => (hit.document as KbOramaDocument).entryId),
          query,
        ).toContain('note:mixed-script-router');
      }
    });
  });
});
