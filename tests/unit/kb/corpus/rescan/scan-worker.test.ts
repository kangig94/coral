import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { CORPUS_SCAN_MAX_FILE_BYTES_ENV, CorpusScanLimitError } from '#src/kb/corpus/rescan/scan.js';
import { buildCorpusScanViewInWorker } from '#src/kb/corpus/rescan/scan-worker.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-corpus-scan-worker-'));
  tempRoots.push(root);
  return root;
}

function env(values: Record<string, string>): { get(key: string): string | undefined } {
  return {
    get: (key) => values[key],
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('corpus scan worker', () => {
  it('reads markdown corpus files off-thread and builds the scan view on return', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(
      join(root, 'notes', 'domain-topic.md'),
      [
        '---',
        'tags: [coral]',
        'principles: []',
        'source: [test/source]',
        'createdAt: 2026-01-01T00:00:00.000Z',
        'updatedAt: 2026-01-01T00:00:00.000Z',
        '---',
        '# Domain Topic',
        '',
        'Body',
        '',
      ].join('\n'),
      'utf-8',
    );

    const scan = await buildCorpusScanViewInWorker({
      markdownRoot: root,
      entityGraphPath: () => join(root, '.entity-graph.json'),
    });

    expect(scan.markdownFiles).toHaveLength(1);
    expect(scan.markdownFiles[0]).toEqual(
      expect.objectContaining({
        kind: 'note',
        slug: 'domain-topic',
        title: 'Domain Topic',
      }),
    );
    expect(scan.entityGraph).toBeNull();
  });

  it('returns corpus scan limit errors from the worker', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'domain-topic.md'), '# Domain Topic\n', 'utf-8');

    await expect(
      buildCorpusScanViewInWorker({
        markdownRoot: root,
        entityGraphPath: () => join(root, '.entity-graph.json'),
        envPort: env({ [CORPUS_SCAN_MAX_FILE_BYTES_ENV]: '4' }),
      }),
    ).rejects.toBeInstanceOf(CorpusScanLimitError);
  });

  it('fails immediately when called with an already aborted signal', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    controller.abort();

    await expect(
      buildCorpusScanViewInWorker(
        {
          markdownRoot: root,
          entityGraphPath: () => join(root, '.entity-graph.json'),
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('KB corpus scan worker aborted');
  });
});
