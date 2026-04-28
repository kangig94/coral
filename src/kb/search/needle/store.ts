import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isRecord } from '../../../infra/json.js';
import { needleIndexDir } from '../../paths.js';
import type { ChunkSeed } from '../../chunking.js';

export const NEEDLE_STORE_SCHEMA_VERSION = 1;
export const NEEDLE_STORE_MIN_NAPI_VERSION = 8;

export type NeedleBridgeManifest = {
  bundleHash: string;
};

export type EmbeddingSpec = {
  specId: string;
  provider: string;
  model: string;
  dims: number;
  normalization: 'l2' | 'none';
  createdAt: string;
};

export type ChunkRecord = ChunkSeed & {
  vector: Float32Array;
  specId: string;
};

export interface NeedleStore {
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

type NativeNeedleAddon = {
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

export type NeedleStoreFactoryOptions = {
  pluginRoot?: string;
  runtimeDir: string;
  addonPath?: string;
};

export class NeedleAddonLoadError extends Error {
  readonly addonPath: string;
  readonly code?: string;

  constructor(message: string, options: { addonPath: string; code?: string; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NeedleAddonLoadError';
    this.addonPath = options.addonPath;
    this.code = options.code;
    Object.setPrototypeOf(this, NeedleAddonLoadError.prototype);
  }
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

function isNativeNeedleAddon(value: unknown): value is NativeNeedleAddon {
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

function parseBridgeManifest(value: unknown): NeedleBridgeManifest | null {
  if (!isRecord(value) || typeof value.bundleHash !== 'string') {
    return null;
  }

  return { bundleHash: value.bundleHash };
}

function parseStats(value: unknown): Awaited<ReturnType<NeedleStore['stats']>> {
  if (!isRecord(value)) {
    throw new Error('Invalid needle store stats payload.');
  }

  const chunkCount = value.chunkCount;
  const specId = value.specId;
  const engineName = value.engineName;
  const addonVersion = value.addonVersion;
  const napiVersion = value.napiVersion;
  const schemaVersion = value.schemaVersion;

  if (typeof chunkCount !== 'number' || !Number.isInteger(chunkCount) || chunkCount < 0) {
    throw new Error('Invalid chunkCount from native needle store.');
  }
  if (specId !== null && typeof specId !== 'string') {
    throw new Error('Invalid specId from native needle store.');
  }
  if (typeof engineName !== 'string' || typeof addonVersion !== 'string') {
    throw new Error('Invalid engine metadata from native needle store.');
  }
  if (typeof napiVersion !== 'number' || !Number.isInteger(napiVersion) || napiVersion < 0) {
    throw new Error('Invalid napiVersion from native needle store.');
  }
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw new Error('Invalid schemaVersion from native needle store.');
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
    throw new Error('Invalid search result payload from native needle store.');
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('Invalid search result entry from native needle store.');
    }

    const { chunkId, entryId, similarity } = entry;
    if (typeof chunkId !== 'string' || typeof entryId !== 'string' || typeof similarity !== 'number') {
      throw new Error('Invalid search result entry from native needle store.');
    }

    return { chunkId, entryId, score: similarity };
  });
}

export function needleAddonPath(runtimeDir: string): string {
  return join(needleIndexDir(runtimeDir), 'coral-needle.node');
}

export function readNeedleBridgeManifest(pluginRoot: string): NeedleBridgeManifest | null {
  try {
    const raw = readFileSync(join(pluginRoot, 'bridge', 'manifest.json'), 'utf8');
    return parseBridgeManifest(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function isNeedleAddonCompatible(
  stats: Awaited<ReturnType<NeedleStore['stats']>>,
): boolean {
  return (
    stats.schemaVersion === NEEDLE_STORE_SCHEMA_VERSION &&
    stats.napiVersion >= NEEDLE_STORE_MIN_NAPI_VERSION
  );
}

function loadNativeAddon(addonPath: string): NativeNeedleAddon | null {
  if (!existsSync(addonPath)) {
    return null;
  }

  try {
    const addonRequire = createRequire(join(dirname(addonPath), 'package.json'));
    const loaded = addonRequire(addonPath) as unknown;
    if (!isNativeNeedleAddon(loaded)) {
      throw new NeedleAddonLoadError('Loaded needle addon did not expose the expected store API.', { addonPath });
    }
    return loaded;
  } catch (error: unknown) {
    if (error instanceof NeedleAddonLoadError) {
      throw error;
    }

    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    throw new NeedleAddonLoadError(`Failed to load needle addon from ${addonPath}.`, {
      addonPath,
      ...(code === undefined ? {} : { code }),
      cause: error,
    });
  }
}

export class NativeNeedleStore implements NeedleStore {
  private dbPath: string | null = null;

  constructor(
    private readonly addon: NativeNeedleAddon,
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
    this.addon.buildIndex(engineName);
  }

  async getActiveSpec(): Promise<EmbeddingSpec | null> {
    const spec = this.addon.getActiveSpec();
    if (spec !== null && !isEmbeddingSpec(spec)) {
      throw new Error('Invalid embedding spec payload from native needle store.');
    }
    return spec;
  }

  async setActiveSpec(spec: EmbeddingSpec): Promise<void> {
    this.ensureInitialized();
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

  private ensureInitialized(): void {
    if (this.dbPath === null) {
      throw new Error('Needle store is not initialized.');
    }
  }
}

export function createNeedleStore(options: NeedleStoreFactoryOptions): NativeNeedleStore | null {
  if (options.pluginRoot !== undefined && readNeedleBridgeManifest(options.pluginRoot) === null) {
    return null;
  }

  const resolvedAddonPath = options.addonPath ?? needleAddonPath(options.runtimeDir);
  const addon = loadNativeAddon(resolvedAddonPath);
  if (addon === null) {
    return null;
  }

  let stats: Awaited<ReturnType<NeedleStore['stats']>>;
  try {
    stats = parseStats(addon.getStats());
  } catch (error: unknown) {
    throw new NeedleAddonLoadError(`Needle addon at ${resolvedAddonPath} reported invalid compatibility metadata.`, {
      addonPath: resolvedAddonPath,
      cause: error,
    });
  }
  if (!isNeedleAddonCompatible(stats)) {
    throw new NeedleAddonLoadError(`Needle addon at ${resolvedAddonPath} is not compatible with this runtime.`, {
      addonPath: resolvedAddonPath,
    });
  }

  return new NativeNeedleStore(addon, options.runtimeDir);
}
