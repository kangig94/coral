import { load, save, type RawData } from '@orama/orama';

import { isNoEntryError } from '../../infra/fs-errors.js';
import type { KbCorpusSnapshot, KbProjectionArtifactFilePort } from '../../kb/contract.js';
import { computeOramaArtifactDigest, createOramaProjectionMetadata } from './artifact-port.js';
import { ORAMA_INDEX_FILE, oramaIndexMetadataPath, oramaIndexPath } from './paths.js';
import { createOramaDb } from './document-builder.js';
import type { KbOramaDb, KbOramaTokenizer } from './schema.js';

export { ORAMA_INDEX_FILE };

export interface KbCachedOramaIndex {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
}

export type OramaSnapshotPorts = {
  files: Pick<
    KbProjectionArtifactFilePort,
    'existsSync' | 'readFileSync' | 'rmSync' | 'writeJsonAtomic'
  >;
};

export class OramaSnapshotStore {
  private cached: KbCachedOramaIndex | null = null;

  constructor(
    private readonly ports: OramaSnapshotPorts,
    private readonly runtimeDir: string,
  ) {}

  hasCache(): boolean {
    return this.cached !== null;
  }

  hasPersistedSnapshot(): boolean {
    return this.ports.files.existsSync(oramaIndexPath(this.runtimeDir));
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
    this.ports.files.rmSync(oramaIndexPath(this.runtimeDir), { force: true });
    this.ports.files.rmSync(oramaIndexMetadataPath(this.runtimeDir), { force: true });
  }

  async load(): Promise<KbCachedOramaIndex> {
    const { db, tokenizer } = await createOramaDb();
    const raw = JSON.parse(this.ports.files.readFileSync(oramaIndexPath(this.runtimeDir), 'utf-8')) as RawData;
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

  async loadReadOnly(): Promise<KbCachedOramaIndex | null> {
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
      }
      return null;
    }
  }

  persist(projected: KbCorpusSnapshot, db: KbOramaDb): void {
    const snapshot = save(db) as unknown as RawData;
    const artifactPath = oramaIndexPath(this.runtimeDir);
    this.ports.files.writeJsonAtomic(artifactPath, snapshot);
    const artifactRaw = this.ports.files.readFileSync(artifactPath, 'utf-8');
    this.ports.files.writeJsonAtomic(
      oramaIndexMetadataPath(this.runtimeDir),
      createOramaProjectionMetadata(projected, computeOramaArtifactDigest(artifactRaw)),
    );
  }
}
