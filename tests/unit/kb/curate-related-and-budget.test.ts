import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CorpusScanMod from '#src/kb/corpus/rescan/scan.js';
import { createCurateTestHandle, type CurateTestHandle } from '#tests/unit/kb/curate/__helpers__/test-handle.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { parseSourceFrontmatter } from '#src/kb/corpus/frontmatter.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { entryIdToVaultLink, sourceEntryId, type KbEntryId } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';

vi.mock('#src/kb/curate/usage-budget.js', () => ({
  isUsageBudgetExhausted: () => false,
}));

vi.mock('#src/kb/corpus/rescan/scan-worker.js', async () => {
  const actual = await vi.importActual<typeof CorpusScanMod>('#src/kb/corpus/rescan/scan.js');
  return {
    CORPUS_SCAN_WORKER_TIMEOUT_MS: 120_000,
    buildCorpusScanViewInWorker: vi.fn(async (...args: Parameters<typeof actual.buildCorpusScanView>) =>
      actual.buildCorpusScanView(...args),
    ),
  };
});
const DEFAULT_IMPORTED_AT = '2026-03-20T00:00:00.000Z';

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function renderRelatedLines(related: KbEntryId[]): string[] {
  if (related.length === 0) {
    return [];
  }

  return ['related:', ...related.map((entryId) => `  - "${entryIdToVaultLink(entryId)}"`)];
}

function renderSource({
  title,
  type = 'spec',
  tags = ['database'],
  url,
  importedAt = DEFAULT_IMPORTED_AT,
  inputFingerprint,
  entrySeq,
  related = [],
  body = 'Body.',
}: {
  title: string;
  type?: string;
  tags?: string[];
  url?: string;
  importedAt?: string;
  inputFingerprint?: string;
  entrySeq?: number;
  related?: KbEntryId[];
  body?: string;
}): string {
  const lines = [
    '---',
    `title: ${title}`,
    `type: ${type}`,
    `tags: [${tags.join(', ')}]`,
    ...(url === undefined ? [] : [`url: ${url}`]),
    `importedAt: ${importedAt}`,
    ...(inputFingerprint === undefined ? [] : [`inputFingerprint: ${inputFingerprint}`]),
    ...(entrySeq === undefined ? [] : [`entrySeq: ${entrySeq}`]),
    ...renderRelatedLines(related),
    '---',
    `# ${title}`,
    '',
    body,
  ];
  return `${lines.join('\n')}\n`;
}

function writeSource(runtime: KbRuntime, slug: string, options: Parameters<typeof renderSource>[0]): string {
  mkdirSync(runtime.sourcesDir(), { recursive: true });
  const sourcePath = join(runtime.sourcesDir(), `${slug}.md`);
  writeFileSync(sourcePath, renderSource(options), 'utf-8');
  return sourcePath;
}

describe('curate related-resolution and budget guards', () => {
  let tempDir: string;
  let runtime: KbRuntime;
  let internals: CurateTestHandle;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-ac6-ac8-'));
    const gitSyncRuntime = createRealRuntime('prod');
    runtime = createTestKbRuntime({
      markdownRoot: tempDir,
      runtimeDir: tempDir,
      db: openKbTestStoreDb(':memory:'),
      runtime: gitSyncRuntime,
    });
    internals = createCurateTestHandle({ kb: runtime });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends source related links, preserves source bytes, and refreshes the live source index', async () => {
    const sourcePath = writeSource(runtime, 'sqlite-query-planner', {
      title: 'SQLite Query Planner',
      tags: ['database'],
      entrySeq: 7,
      related: ['note:coral-alpha'],
      body: '## Outline\nKeep the source body stable.\n',
    });
    const originalRaw = readFileSync(sourcePath, 'utf-8');
    const preservedTail = originalRaw.slice(originalRaw.indexOf('# '));

    runtime.writeIndex({
      entries: {
        [sourceEntryId('sqlite-query-planner')]: {
          kind: 'source',
          slug: 'sqlite-query-planner',
          title: 'SQLite Query Planner',
          type: 'spec',
          tags: ['database'],
          importedAt: DEFAULT_IMPORTED_AT,
          related: ['note:coral-alpha'],
          bodyHash: computeBodySurfaceHash('## Outline\nKeep the source body stable.'),
          entrySeq: 7,
        },
      },
      principles: {},
      entityMeta: {},
      relationships: [],
    });

    await internals.commitMetadataTargets([
      {
        kind: 'source',
        entryId: sourceEntryId('sqlite-query-planner'),
        slug: 'sqlite-query-planner',
        entrySeq: 7,
        claimTimeFingerprint: fingerprint(originalRaw),
        addTags: ['kb'],
        addRelated: ['source:sqlite-overview', 'note:coral-alpha'],
      },
    ]);

    const updatedRaw = readFileSync(sourcePath, 'utf-8');
    expect(updatedRaw.slice(updatedRaw.indexOf('# '))).toBe(preservedTail);
    expect(parseSourceFrontmatter(updatedRaw)).toEqual({
      title: 'SQLite Query Planner',
      type: 'spec',
      tags: ['database', 'kb'],
      importedAt: DEFAULT_IMPORTED_AT,
      related: ['note:coral-alpha', 'source:sqlite-overview'],
      inputFingerprint: computeBodySurfaceHash('## Outline\nKeep the source body stable.'),
      entrySeq: 7,
    });
    expect(updatedRaw).toContain('"[[notes/coral-alpha]]"');
    expect(updatedRaw).toContain('"[[sources/sqlite-overview]]"');
    expect(runtime.readIndex()?.entries[sourceEntryId('sqlite-query-planner')]).toEqual({
      kind: 'source',
      slug: 'sqlite-query-planner',
      title: 'SQLite Query Planner',
      type: 'spec',
      tags: ['database', 'kb'],
      importedAt: DEFAULT_IMPORTED_AT,
      related: ['note:coral-alpha', 'source:sqlite-overview'],
      bodyHash: computeBodySurfaceHash('## Outline\nKeep the source body stable.'),
      inputFingerprint: computeBodySurfaceHash('## Outline\nKeep the source body stable.'),
      entrySeq: 7,
    });
  });
});
