import { describe, expect, it, vi } from 'vitest';

import {
  CORPUS_SCAN_MAX_FILE_BYTES_ENV,
  CorpusScanLimitError,
  buildCorpusScanView,
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
      throw noEntryError(String(path));
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
});
