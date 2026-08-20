import { join } from 'node:path';
import { compareLocale } from '../../validation.js';
import { isNoEntryError } from '../../../infra/fs-errors.js';
import type { StoragePort } from '../../../infra/port-types.js';

export type CorpusMarkdownKind = 'note' | 'source' | 'community' | 'principle' | 'wiki';

export interface CorpusFileHandle {
  readonly path: string;
  readonly kind: CorpusMarkdownKind;
  sizeBytes(): number;
  read(): string;
  mtimeNs(): bigint;
}

/** The infra `StoragePort` stays domain-free; this layer adds the corpus vocabulary. */
export type CorpusStorage = Pick<StoragePort, 'readFileSync' | 'statSync' | 'existsSync'> & {
  scan(root: string): Iterable<CorpusFileHandle>;
};

const CORPUS_SUBDIR_BY_KIND: Readonly<Record<CorpusMarkdownKind, string>> = {
  note: 'notes',
  source: 'sources',
  community: 'communities',
  principle: 'principles',
  wiki: 'wiki',
};

const CORPUS_KINDS: readonly CorpusMarkdownKind[] = ['note', 'source', 'community', 'principle', 'wiki'];

export function createCorpusStorage(infraStorage: StoragePort): CorpusStorage {
  return {
    readFileSync: infraStorage.readFileSync.bind(infraStorage),
    statSync: infraStorage.statSync.bind(infraStorage),
    existsSync: infraStorage.existsSync.bind(infraStorage),
    *scan(root: string): Iterable<CorpusFileHandle> {
      for (const kind of CORPUS_KINDS) {
        const dirPath = join(root, CORPUS_SUBDIR_BY_KIND[kind]);
        for (const name of sortedMarkdownEntries(infraStorage, dirPath)) {
          const filePath = join(dirPath, name);
          yield {
            path: filePath,
            kind,
            sizeBytes: () => infraStorage.statSync(filePath).size,
            read: () => infraStorage.readFileSync(filePath, 'utf-8'),
            mtimeNs: () => infraStorage.statSync(filePath, { bigint: true }).mtimeNs,
          };
        }
      }
    },
  };
}

function sortedMarkdownEntries(storage: StoragePort, dirPath: string): string[] {
  try {
    const entries: string[] = [];
    for (const entry of storage.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        entries.push(entry.name);
      }
    }
    return entries.sort(compareLocale);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}
