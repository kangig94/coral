import { describe, expect, it, vi } from 'vitest';

import {
  CORPUS_SCAN_FRONTMATTER_MAX_BYTES_ENV,
  CORPUS_SCAN_MAX_FILE_BYTES_ENV,
  CorpusScanLimitError,
  buildCorpusScanView,
  createCorpusMarkdownFileScan,
} from '#src/kb/corpus/rescan/scan.js';
import type { CorpusFileHandle, CorpusStorage } from '#src/kb/corpus/rescan/storage.js';

function noEntryError(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function handle(sizeBytes: number, read: () => string = () => '# Title\n'): CorpusFileHandle {
  return {
    kind: 'note',
    path: '/vault/notes/limit-test.md',
    sizeBytes: () => sizeBytes,
    read,
    mtimeNs: () => 1n,
  };
}

function storageFor(handles: readonly CorpusFileHandle[]): CorpusStorage {
  return {
    existsSync: () => false,
    readFileSync: (path) => {
      throw noEntryError(path);
    },
    statSync: ((path: string) => {
      throw noEntryError(path);
    }) as CorpusStorage['statSync'],
    scan: () => handles,
  };
}

function env(values: Record<string, string>): { get(key: string): string | undefined } {
  return {
    get: (key) => values[key],
  };
}

describe('corpus scan limits', () => {
  it('rejects oversized markdown files before reading content', () => {
    const read = vi.fn(() => {
      throw new Error('read should not be called');
    });
    const corpusStorage = storageFor([handle(5, read)]);

    expect(() =>
      buildCorpusScanView({
        markdownRoot: '/vault',
        corpusStorage,
        entityGraphPath: () => '/vault/.entity-graph.json',
        envPort: env({ [CORPUS_SCAN_MAX_FILE_BYTES_ENV]: '4' }),
      }),
    ).toThrow(CorpusScanLimitError);
    expect(read).not.toHaveBeenCalled();
  });

  it('allows larger markdown files when the max file byte cap is raised', () => {
    const corpusStorage = storageFor([handle(5, () => '# Limit Test\n')]);

    const scan = buildCorpusScanView({
      markdownRoot: '/vault',
      corpusStorage,
      entityGraphPath: () => '/vault/.entity-graph.json',
      envPort: env({ [CORPUS_SCAN_MAX_FILE_BYTES_ENV]: '5' }),
    });

    expect(scan.markdownFiles).toHaveLength(1);
  });

  it('records an oversized frontmatter block as a scan error before YAML parsing', () => {
    const file = createCorpusMarkdownFileScan({
      kind: 'note',
      path: '/vault/notes/limit-test.md',
      content: ['---', 'title: Limit Test', 'tags: []', 'principles: []', '---', '# Limit Test', ''].join('\n'),
      frontmatterMaxBytes: 4,
    });

    expect(file.frontmatter.status).toBe('error');
    expect(file.frontmatter.error).toBeInstanceOf(CorpusScanLimitError);
    expect((file.frontmatter.error as Error).message).toContain(CORPUS_SCAN_FRONTMATTER_MAX_BYTES_ENV);
  });
});
