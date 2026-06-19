import { load, save, type RawData } from '@orama/orama';

import { isNoEntryError } from '../../infra/fs-errors.js';
import type { KbCorpusSnapshot, KbProjectionArtifactFilePort } from '../../kb/contract.js';
import {
  computeOramaArtifactDigest,
  createOramaEntryManifestFromArtifact,
  createOramaProjectionMetadata,
  readOramaProjectionArtifact,
  type OramaProjectionIdentityInput,
  type OramaProjectionMetadata,
} from './artifact-port.js';
import { oramaIndexMetadataPath, oramaIndexPath } from './paths.js';
import { createOramaDb } from './document-builder.js';
import type { KbOramaDb, KbOramaTokenizer } from './schema.js';

export interface KbCachedOramaIndex {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
  metadata?: OramaProjectionMetadata;
}

export type OramaSnapshotPorts = {
  files: Pick<KbProjectionArtifactFilePort, 'existsSync' | 'readFileSync' | 'rmSync' | 'writeJsonAtomic'>;
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
    return (
      this.ports.files.existsSync(oramaIndexPath(this.runtimeDir)) &&
      this.ports.files.existsSync(oramaIndexMetadataPath(this.runtimeDir))
    );
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
    const artifactPath = oramaIndexPath(this.runtimeDir);
    const metadataPath = oramaIndexMetadataPath(this.runtimeDir);
    const { artifactRaw, metadata } = readOramaProjectionArtifact(this.ports.files, artifactPath, metadataPath);
    const { db, tokenizer } = await createOramaDb();
    const raw = JSON.parse(artifactRaw) as RawData;
    load(db, raw);
    return { db, tokenizer, metadata };
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

  persist(projected: KbCorpusSnapshot, db: KbOramaDb, identityInput: OramaProjectionIdentityInput = {}): void {
    const snapshot = save(db) as unknown as RawData;
    const artifactPath = oramaIndexPath(this.runtimeDir);
    this.ports.files.writeJsonAtomic(artifactPath, snapshot);
    const artifactRaw = this.ports.files.readFileSync(artifactPath, 'utf-8');
    const entryManifest = createOramaEntryManifestFromArtifact(snapshot);
    this.ports.files.writeJsonAtomic(
      oramaIndexMetadataPath(this.runtimeDir),
      createOramaProjectionMetadata(projected, computeOramaArtifactDigest(artifactRaw), entryManifest, identityInput),
    );
  }
}
