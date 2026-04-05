import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  VECTOR_STORE_MIN_NAPI_VERSION,
  VECTOR_STORE_SCHEMA_VERSION,
  type VectorBridgeManifest,
} from './vector-store-contract.js';

const ACTIVE_POINTER_FILE = 'ACTIVE';
const ADDON_FILE = 'coral-needle.node';
const STORE_FILE = 'store.duckdb';

export type EmbeddingSpec = {
  specId: string;
  provider: string;
  model: string;
  dims: number;
  normalization: 'l2' | 'none';
  createdAt: string;
};

export type ChunkRecord = {
  id: string;
  entryId: string;
  entryKind: string;
  chunkIndex: number;
  text: string;
  contentHash: string;
  vector: Float32Array;
  specId: string;
};

export interface VectorStore {
  init(dbPath: string): Promise<void>;
  close(): Promise<void>;
  upsertChunks(chunks: ChunkRecord[]): Promise<void>;
  removeByEntryId(entryId: string): Promise<void>;
  searchVector(
    query: Float32Array,
    candidateK: number,
  ): Promise<Array<{ chunkId: string; entryId: string; score: number }>>;
  buildIndex(engineName?: string): Promise<void>;
  getActiveSpec(): Promise<EmbeddingSpec | null>;
  setActiveSpec(spec: EmbeddingSpec): Promise<void>;
  stats(): Promise<{
    chunkCount: number;
    specId: string | null;
    engineName: string;
    addonVersion: string;
    napiVersion: number;
    schemaVersion: number;
  }>;
}

type NativeVectorStoreAddon = {
  initStore(dbPath: string): void;
  closeStore(): void;
  upsertChunks(chunks: ChunkRecord[]): void;
  removeByEntryId(entryId: string): void;
  searchVector(query: Float32Array, candidateK: number): Array<{ chunkId: string; entryId: string; similarity: number }>;
  buildIndex(engineName?: string): void;
  getActiveSpec(): EmbeddingSpec | null;
  setActiveSpec(spec: EmbeddingSpec): void;
  listEngines(): Array<{ name: string; available: boolean; description: string }>;
  getStats(): {
    chunkCount: number;
    specId: string | null;
    engineName: string;
    addonVersion: string;
    napiVersion: number;
    schemaVersion: number;
  };
};

type VectorStoreFactoryOptions = {
  pluginRoot: string;
  runtimeDir: string;
  addonPath?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEmbeddingSpec(value: unknown): value is EmbeddingSpec {
  return (
    isRecord(value) &&
    typeof value.specId === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    typeof value.dims === 'number' &&
    Number.isInteger(value.dims) &&
    value.dims > 0 &&
    (value.normalization === 'l2' || value.normalization === 'none') &&
    typeof value.createdAt === 'string'
  );
}

function isNativeVectorStoreAddon(value: unknown): value is NativeVectorStoreAddon {
  return (
    isRecord(value) &&
    typeof value.initStore === 'function' &&
    typeof value.closeStore === 'function' &&
    typeof value.upsertChunks === 'function' &&
    typeof value.removeByEntryId === 'function' &&
    typeof value.searchVector === 'function' &&
    typeof value.buildIndex === 'function' &&
    typeof value.listEngines === 'function' &&
    typeof value.getActiveSpec === 'function' &&
    typeof value.setActiveSpec === 'function' &&
    typeof value.getStats === 'function'
  );
}

function parseBridgeManifest(value: unknown): VectorBridgeManifest | null {
  if (!isRecord(value) || typeof value.bundleHash !== 'string') {
    return null;
  }

  return { bundleHash: value.bundleHash };
}

function parseStats(value: unknown): Awaited<ReturnType<VectorStore['stats']>> {
  if (!isRecord(value)) {
    throw new Error('Invalid vector store stats payload.');
  }

  const chunkCount = value.chunkCount;
  const specId = value.specId;
  const engineName = value.engineName;
  const addonVersion = value.addonVersion;
  const napiVersion = value.napiVersion;
  const schemaVersion = value.schemaVersion;

  if (typeof chunkCount !== 'number' || !Number.isInteger(chunkCount) || chunkCount < 0) {
    throw new Error('Invalid chunkCount from native vector store.');
  }
  if (specId !== null && typeof specId !== 'string') {
    throw new Error('Invalid specId from native vector store.');
  }
  if (typeof engineName !== 'string' || typeof addonVersion !== 'string') {
    throw new Error('Invalid engine metadata from native vector store.');
  }
  if (typeof napiVersion !== 'number' || !Number.isInteger(napiVersion) || napiVersion < 0) {
    throw new Error('Invalid napiVersion from native vector store.');
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new Error('Invalid schemaVersion from native vector store.');
  }

  return {
    chunkCount,
    specId: specId ?? null,
    engineName,
    addonVersion,
    napiVersion,
    schemaVersion,
  };
}

function parseSearchResults(value: unknown): Array<{ chunkId: string; entryId: string; score: number }> {
  if (!Array.isArray(value)) {
    throw new Error('Invalid search result payload from native vector store.');
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('Invalid search result entry from native vector store.');
    }

    const { chunkId, entryId, similarity } = entry;
    if (typeof chunkId !== 'string' || typeof entryId !== 'string' || typeof similarity !== 'number') {
      throw new Error('Invalid search result entry from native vector store.');
    }

    return { chunkId, entryId, score: similarity };
  });
}

function vectorRootDir(runtimeDir: string): string {
  return join(runtimeDir, 'vec');
}

export function vectorAddonPath(runtimeDir: string): string {
  return join(vectorRootDir(runtimeDir), ADDON_FILE);
}

export function vectorSpecsDir(runtimeDir: string): string {
  return join(vectorRootDir(runtimeDir), 'specs');
}

export function vectorSpecDir(runtimeDir: string, specId: string): string {
  return join(vectorSpecsDir(runtimeDir), specId);
}

export function vectorSnapshotsDir(runtimeDir: string, specId: string): string {
  return join(vectorSpecDir(runtimeDir, specId), 'snapshots');
}

export function vectorSnapshotDir(runtimeDir: string, specId: string, snapshotId: string): string {
  return join(vectorSnapshotsDir(runtimeDir, specId), snapshotId);
}

export function vectorSnapshotDbPath(runtimeDir: string, specId: string, snapshotId: string): string {
  return join(vectorSnapshotDir(runtimeDir, specId, snapshotId), STORE_FILE);
}

export function vectorActivePointerPath(runtimeDir: string, specId: string): string {
  return join(vectorSpecDir(runtimeDir, specId), ACTIVE_POINTER_FILE);
}

export function readVectorBridgeManifest(pluginRoot: string): VectorBridgeManifest | null {
  try {
    const raw = readFileSync(join(pluginRoot, 'bridge', 'manifest.json'), 'utf8');
    return parseBridgeManifest(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function readActiveSnapshotId(runtimeDir: string, specId: string): string | null {
  try {
    const snapshotId = readFileSync(vectorActivePointerPath(runtimeDir, specId), 'utf8').trim();
    return snapshotId === '' ? null : snapshotId;
  } catch {
    return null;
  }
}

export function resolveActiveSnapshotDbPath(runtimeDir: string, specId: string): string | null {
  const snapshotId = readActiveSnapshotId(runtimeDir, specId);
  if (snapshotId === null) {
    return null;
  }

  return vectorSnapshotDbPath(runtimeDir, specId, snapshotId);
}

export function prepareSnapshotDbPath(runtimeDir: string, specId: string, snapshotId: string): string {
  const dbPath = vectorSnapshotDbPath(runtimeDir, specId, snapshotId);
  mkdirSync(dirname(dbPath), { recursive: true });
  return dbPath;
}

export function writeActiveSnapshotId(runtimeDir: string, specId: string, snapshotId: string): void {
  const pointerPath = vectorActivePointerPath(runtimeDir, specId);
  const tmpPath = `${pointerPath}.tmp`;

  mkdirSync(dirname(pointerPath), { recursive: true });
  writeFileSync(tmpPath, `${snapshotId}\n`, 'utf8');
  renameSync(tmpPath, pointerPath);
}

export function isVectorAddonCompatible(
  stats: Awaited<ReturnType<VectorStore['stats']>>,
): boolean {
  return (
    stats.schemaVersion === VECTOR_STORE_SCHEMA_VERSION &&
    stats.napiVersion >= VECTOR_STORE_MIN_NAPI_VERSION
  );
}

function loadNativeAddon(addonPath: string): NativeVectorStoreAddon | null {
  if (!existsSync(addonPath)) {
    return null;
  }

  try {
    const addonRequire = createRequire(join(dirname(addonPath), 'package.json'));
    const loaded = addonRequire(addonPath) as unknown;
    return isNativeVectorStoreAddon(loaded) ? loaded : null;
  } catch {
    return null;
  }
}

export class DuckDBVectorStore implements VectorStore {
  private dbPath: string | null = null;

  constructor(
    private readonly addon: NativeVectorStoreAddon,
    readonly runtimeDir: string,
  ) {}

  async init(dbPath: string): Promise<void> {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.addon.initStore(dbPath);
    this.dbPath = dbPath;
  }

  async close(): Promise<void> {
    if (this.dbPath === null) {
      return;
    }

    this.addon.closeStore();
    this.dbPath = null;
  }

  async upsertChunks(chunks: ChunkRecord[]): Promise<void> {
    this.ensureInitialized();
    this.addon.upsertChunks(chunks);
  }

  async removeByEntryId(entryId: string): Promise<void> {
    this.ensureInitialized();
    this.addon.removeByEntryId(entryId);
  }

  async searchVector(
    query: Float32Array,
    candidateK: number,
  ): Promise<Array<{ chunkId: string; entryId: string; score: number }>> {
    this.ensureInitialized();
    return parseSearchResults(this.addon.searchVector(query, candidateK));
  }

  async buildIndex(engineName?: string): Promise<void> {
    this.ensureInitialized();

    if (engineName === undefined) {
      this.addon.buildIndex();
      return;
    }

    this.addon.buildIndex(engineName);
  }

  async getActiveSpec(): Promise<EmbeddingSpec | null> {
    const spec = this.addon.getActiveSpec();
    if (spec === null) {
      return null;
    }
    if (!isEmbeddingSpec(spec)) {
      throw new Error('Invalid embedding spec payload from native vector store.');
    }
    return spec;
  }

  async setActiveSpec(spec: EmbeddingSpec): Promise<void> {
    this.ensureInitialized();
    mkdirSync(vectorSnapshotsDir(this.runtimeDir, spec.specId), { recursive: true });
    this.addon.setActiveSpec(spec);
  }

  async stats(): Promise<{
    chunkCount: number;
    specId: string | null;
    engineName: string;
    addonVersion: string;
    napiVersion: number;
    schemaVersion: number;
  }> {
    return parseStats(this.addon.getStats());
  }

  snapshotDbPath(specId: string, snapshotId: string): string {
    return vectorSnapshotDbPath(this.runtimeDir, specId, snapshotId);
  }

  prepareSnapshot(specId: string, snapshotId: string): string {
    return prepareSnapshotDbPath(this.runtimeDir, specId, snapshotId);
  }

  readActiveSnapshotId(specId: string): string | null {
    return readActiveSnapshotId(this.runtimeDir, specId);
  }

  resolveActiveSnapshotDbPath(specId: string): string | null {
    return resolveActiveSnapshotDbPath(this.runtimeDir, specId);
  }

  writeActiveSnapshot(specId: string, snapshotId: string): void {
    writeActiveSnapshotId(this.runtimeDir, specId, snapshotId);
  }

  async initActiveSnapshot(specId: string): Promise<string | null> {
    const snapshotId = this.readActiveSnapshotId(specId);
    if (snapshotId === null) {
      return null;
    }

    await this.init(this.snapshotDbPath(specId, snapshotId));
    return snapshotId;
  }

  private ensureInitialized(): void {
    if (this.dbPath !== null) {
      return;
    }
    throw new Error('Vector store is not initialized.');
  }
}

export function createDuckDBVectorStore(options: VectorStoreFactoryOptions): DuckDBVectorStore | null {
  const manifest = readVectorBridgeManifest(options.pluginRoot);
  if (manifest === null) {
    return null;
  }

  const addon = loadNativeAddon(options.addonPath ?? vectorAddonPath(options.runtimeDir));
  if (addon === null) {
    return null;
  }

  const stats = parseStats(addon.getStats());
  if (!isVectorAddonCompatible(stats)) {
    return null;
  }

  return new DuckDBVectorStore(addon, options.runtimeDir);
}
