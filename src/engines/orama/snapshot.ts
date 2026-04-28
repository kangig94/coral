import { load, save, type RawData } from '@orama/orama';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { isNoEntryError } from '../../infra/fs-errors.js';
import type { KbCachedOramaIndex } from '../../kb/contract.js';
import { writeJsonAtomic } from '../../kb/corpus/index-store.js';
import { oramaSnapshotDir } from './paths.js';
import { createOramaDb } from './document-builder.js';
import type { KbOramaDb } from './schema.js';

export const ORAMA_INDEX_FILE = 'orama-index.json';

export class OramaSnapshotStore {
  private cached: KbCachedOramaIndex | null = null;

  constructor(private readonly runtimeDir: string) {}

  hasCache(): boolean {
    return this.cached !== null;
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
    rmSync(this.oramaIndexPath(), { force: true });
  }

  async load(): Promise<KbCachedOramaIndex> {
    const { db, tokenizer } = await createOramaDb();
    const raw = JSON.parse(readFileSync(this.oramaIndexPath(), 'utf-8')) as RawData;
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
    writeJsonAtomic(this.oramaIndexPath(), snapshot);
  }

  oramaIndexPath(): string {
    return join(oramaSnapshotDir(this.runtimeDir), ORAMA_INDEX_FILE);
  }
}
