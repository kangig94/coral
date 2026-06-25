import { setImmediate as waitImmediate } from 'node:timers/promises';

import { load, save, type RawData } from '@orama/orama';

import { backendLog } from '../../infra/backend-log.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import type { KbCorpusSnapshot, KbProjectionArtifactFilePort } from '../../kb/contract.js';
import {
  computeOramaArtifactDigest,
  createOramaEntryManifestFromArtifact,
  createOramaProjectionMetadata,
  createOramaProjectionMetadataBase,
  oramaProjectionTokenizerTier,
  readOramaProjectionArtifact,
  readOramaProjectionMetadata,
  type OramaProjectionIdentityInput,
  type OramaProjectionMetadata,
} from './artifact-port.js';
import { oramaIndexMetadataPath, oramaIndexPath } from './paths.js';
import { createOramaDb, type OramaTokenizerAnalyzer } from './document-builder.js';
import type { KbOramaDb, KbOramaTokenizer } from './schema.js';
import { serializeOramaProjectionArtifactInWorker } from './snapshot-worker.js';

export const ORAMA_SNAPSHOT_SAVE_WARN_MS = 250;

export interface KbCachedOramaIndex {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
  metadata?: OramaProjectionMetadata;
  fallback?: true;
}

export type OramaSnapshotPorts = {
  files: Pick<KbProjectionArtifactFilePort, 'existsSync' | 'readFileSync' | 'rmSync' | 'writeJsonAtomic'> &
    Partial<Pick<KbProjectionArtifactFilePort, 'writeTextAtomic'>>;
};

export type OramaSnapshotLoadOptions = {
  currentKiwiAnalyzer?: () => OramaTokenizerAnalyzer | null;
};

export class OramaSnapshotStore {
  private cached: KbCachedOramaIndex | null = null;
  private currentKiwiAnalyzer: () => OramaTokenizerAnalyzer | null = () => null;

  private readonly ports: OramaSnapshotPorts;
  private readonly runtimeDir: string;
  constructor(ports: OramaSnapshotPorts, runtimeDir: string) {
    this.ports = ports;
    this.runtimeDir = runtimeDir;
  }

  setCurrentKiwiAnalyzer(getter: () => OramaTokenizerAnalyzer | null): void {
    this.currentKiwiAnalyzer = getter;
  }

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

  async load(options: OramaSnapshotLoadOptions = {}): Promise<KbCachedOramaIndex> {
    const artifactPath = oramaIndexPath(this.runtimeDir);
    const metadataPath = oramaIndexMetadataPath(this.runtimeDir);
    const { artifactRaw, metadata } = readOramaProjectionArtifact(this.ports.files, artifactPath, metadataPath);
    const { db, tokenizer } = await createOramaDb({
      currentKiwiAnalyzer: this.currentKiwiAnalyzerFor(metadata, options.currentKiwiAnalyzer),
    });
    const raw = JSON.parse(artifactRaw) as RawData;
    load(db, raw);
    return { db, tokenizer, metadata };
  }

  loadMetadata(): OramaProjectionMetadata {
    return readOramaProjectionMetadata(this.ports.files, oramaIndexMetadataPath(this.runtimeDir));
  }

  async loadIfPresent(options: OramaSnapshotLoadOptions = {}): Promise<KbCachedOramaIndex | null> {
    if (this.cached !== null) {
      return this.cached;
    }

    try {
      const loaded = await this.load(options);
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

  async loadReadOnly(options: OramaSnapshotLoadOptions = {}): Promise<KbCachedOramaIndex | null> {
    if (this.cached !== null) {
      return this.cached;
    }

    try {
      const loaded = await this.load(options);
      this.install(loaded);
      return loaded;
    } catch (error: unknown) {
      if (!isNoEntryError(error)) {
        this.clear();
      }
      return null;
    }
  }

  persist(
    projected: KbCorpusSnapshot,
    db: KbOramaDb,
    identityInput: OramaProjectionIdentityInput = {},
  ): OramaProjectionMetadata {
    const snapshot = this.saveSnapshotWithTiming(db);
    return this.persistSavedSnapshot(projected, snapshot, identityInput);
  }

  async persistAsync(
    projected: KbCorpusSnapshot,
    db: KbOramaDb,
    identityInput: OramaProjectionIdentityInput = {},
  ): Promise<OramaProjectionMetadata> {
    await waitImmediate();
    const snapshot = this.saveSnapshotWithTiming(db);
    if (this.ports.files.writeTextAtomic === undefined) {
      return this.persistSavedSnapshot(projected, snapshot, identityInput);
    }

    const artifact = await serializeOramaProjectionArtifactInWorker(
      snapshot,
      createOramaProjectionMetadataBase(projected, identityInput),
    );
    this.ports.files.writeTextAtomic(oramaIndexPath(this.runtimeDir), artifact.artifactRaw);
    this.ports.files.writeTextAtomic(oramaIndexMetadataPath(this.runtimeDir), artifact.metadataRaw);
    return artifact.metadata;
  }

  private saveSnapshotWithTiming(db: KbOramaDb): RawData {
    const startedAt = Date.now();
    const snapshot = save(db) as unknown as RawData;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= ORAMA_SNAPSHOT_SAVE_WARN_MS) {
      backendLog.warn(`[orama] snapshot save took ${elapsedMs}ms on the daemon thread`);
    }
    return snapshot;
  }

  private persistSavedSnapshot(
    projected: KbCorpusSnapshot,
    snapshot: RawData,
    identityInput: OramaProjectionIdentityInput,
  ): OramaProjectionMetadata {
    const artifactPath = oramaIndexPath(this.runtimeDir);
    this.ports.files.writeJsonAtomic(artifactPath, snapshot);
    const artifactRaw = this.ports.files.readFileSync(artifactPath, 'utf-8');
    const entryManifest = createOramaEntryManifestFromArtifact(snapshot);
    const metadata = createOramaProjectionMetadata(
      projected,
      computeOramaArtifactDigest(artifactRaw),
      entryManifest,
      identityInput,
    );
    this.ports.files.writeJsonAtomic(oramaIndexMetadataPath(this.runtimeDir), metadata);
    return metadata;
  }

  private currentKiwiAnalyzerFor(
    metadata: OramaProjectionMetadata,
    currentKiwiAnalyzer: () => OramaTokenizerAnalyzer | null = this.currentKiwiAnalyzer,
  ): () => OramaTokenizerAnalyzer | null {
    return oramaProjectionTokenizerTier(metadata) === 'kiwi' ? currentKiwiAnalyzer : () => null;
  }
}
