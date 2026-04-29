import { load, save, type RawData } from '@orama/orama';
import { join } from 'node:path';

import { isNoEntryError } from '../../infra/fs-errors.js';
import type { FileAtomicHost } from '../../kb/corpus/file-atomic.js';
import { writeJsonAtomic } from '../../kb/corpus/index-store.js';
import type { IdPort, StoragePort } from '../../runtime/ports.js';
import { oramaSnapshotDir } from './paths.js';
import { createOramaDb } from './document-builder.js';
import type { KbOramaDb, KbOramaTokenizer } from './schema.js';

export const ORAMA_INDEX_FILE = 'orama-index.json';

export interface KbCachedOramaIndex {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
}

export type OramaSnapshotPorts = {
  storage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'rmSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync'>;
  ids: Pick<IdPort, 'uuid'>;
};

export class OramaSnapshotStore {
  private cached: KbCachedOramaIndex | null = null;
  private readonly host: FileAtomicHost;

  constructor(
    private readonly ports: OramaSnapshotPorts,
    private readonly runtimeDir: string,
  ) {
    this.host = { storagePort: ports.storage, ids: ports.ids };
  }

  hasCache(): boolean {
    return this.cached !== null;
  }

  hasPersistedSnapshot(): boolean {
    return this.ports.storage.existsSync(this.oramaIndexPath());
  }

  getCache(): KbCachedOramaIndex | null {
    return this.cached;
  }

  install(cache: KbCachedOramaIndex): void {
    this.cached = cache;
  }

  clear(): void {
    this.cached = null;
  }

  removeSnapshot(): void {
    this.ports.storage.rmSync(this.oramaIndexPath(), { force: true });
  }

  async load(): Promise<KbCachedOramaIndex> {
    const { db, tokenizer } = await createOramaDb();
    const raw = JSON.parse(this.ports.storage.readFileSync(this.oramaIndexPath(), 'utf-8')) as RawData;
    load(db, raw);
    return { db, tokenizer };
  }

  async loadIfPresent(): Promise<KbCachedOramaIndex | null> {
    if (this.cached !== null) {
      return this.cached;
    }

    try {
      const loaded = await this.load();
      this.install(loaded);
      return loaded;
    } catch (error: unknown) {
      if (!isNoEntryError(error)) {
        this.clear();
        this.removeSnapshot();
      }
      return null;
    }
  }

  persist(db: KbOramaDb): void {
    const snapshot = save(db) as unknown as RawData;
    writeJsonAtomic(this.host, this.oramaIndexPath(), snapshot);
  }

  oramaIndexPath(): string {
    return join(oramaSnapshotDir(this.runtimeDir), ORAMA_INDEX_FILE);
  }
}
