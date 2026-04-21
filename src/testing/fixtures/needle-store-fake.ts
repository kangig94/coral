import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ChunkRecord, EmbeddingSpec, NeedleStore } from '../../kb/search/needle-store.js';

type PersistedNeedleStoreFakeState = {
  activeSpec: EmbeddingSpec | null;
  chunks: Array<{
    id: string;
    entryId: string;
    entryKind: string;
    chunkIndex: number;
    text: string;
    contentHash: string;
    vector: number[];
    specId: string;
  }>;
  buildCount: number;
};

export interface NeedleStoreFakeOptions {
  readonly failInit?: Error;
  readonly failUpsertChunks?: Error;
  readonly failBuildIndex?: Error;
  readonly searchResults?: Array<{ chunkId: string; entryId: string; score: number }>;
}

function defaultState(): PersistedNeedleStoreFakeState {
  return {
    activeSpec: null,
    chunks: [],
    buildCount: 0,
  };
}

function loadState(dbPath: string): PersistedNeedleStoreFakeState {
  if (!existsSync(dbPath)) {
    return defaultState();
  }

  return JSON.parse(readFileSync(dbPath, 'utf8')) as PersistedNeedleStoreFakeState;
}

function persistState(dbPath: string, state: PersistedNeedleStoreFakeState): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function createNeedleStoreFake(options: NeedleStoreFakeOptions = {}): NeedleStore {
  let dbPath: string | null = null;
  let state = defaultState();

  return {
    async init(nextDbPath: string): Promise<void> {
      if (options.failInit) {
        throw options.failInit;
      }

      dbPath = nextDbPath;
      state = loadState(nextDbPath);
    },

    async close(): Promise<void> {
      if (dbPath !== null) {
        persistState(dbPath, state);
      }
    },

    async upsertChunks(chunks: ChunkRecord[]): Promise<void> {
      if (options.failUpsertChunks) {
        throw options.failUpsertChunks;
      }

      const nextChunks = new Map(state.chunks.map((chunk) => [chunk.id, chunk]));
      for (const chunk of chunks) {
        nextChunks.set(chunk.id, {
          id: chunk.id,
          entryId: chunk.entryId,
          entryKind: chunk.entryKind,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          contentHash: chunk.contentHash,
          vector: [...chunk.vector],
          specId: chunk.specId,
        });
      }
      state.chunks = [...nextChunks.values()].sort((left, right) => left.id.localeCompare(right.id));
    },

    async removeByEntryId(entryId: string): Promise<void> {
      state.chunks = state.chunks.filter((chunk) => chunk.entryId !== entryId);
    },

    async searchVector(): Promise<Array<{ chunkId: string; entryId: string; score: number }>> {
      return [...(options.searchResults ?? [])];
    },

    async buildIndex(): Promise<void> {
      if (options.failBuildIndex) {
        throw options.failBuildIndex;
      }
      state.buildCount += 1;
    },

    async getActiveSpec(): Promise<EmbeddingSpec | null> {
      return state.activeSpec;
    },

    async setActiveSpec(spec: EmbeddingSpec): Promise<void> {
      state.activeSpec = spec;
    },

    async stats(): Promise<{
      chunkCount: number;
      specId: string | null;
      engineName: string;
      addonVersion: string;
      napiVersion: number;
      schemaVersion: number;
    }> {
      return {
        chunkCount: state.chunks.length,
        specId: state.activeSpec?.specId ?? null,
        engineName: 'fake',
        addonVersion: 'fake',
        napiVersion: 8,
        schemaVersion: 1,
      };
    },
  };
}
