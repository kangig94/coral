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
