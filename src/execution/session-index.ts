import { basename, join } from 'node:path';
import { readSessionEntryLenient, type LenientSessionEntry } from '../shared/session-entry.js';
import type { ProgressStore } from './progress-store.js';
import { listSessionShards } from './session-manager.js';
import type { Runtime, RuntimePathsPort, RuntimeStoragePort } from './runtime.js';

type SessionIndexRow = { shardHash: string; sessions: LenientSessionEntry[] };

export class SessionIndex {
  private readonly storage: RuntimeStoragePort;
  private readonly paths: RuntimePathsPort;
  private readonly index = new Map<string, Map<string, LenientSessionEntry>>();
  private readonly shardDirs = new Map<string, string>();
  private readonly staleSessionIds = new Map<string, Set<string>>();

  constructor(runtime: Pick<Runtime, 'storage' | 'paths'>) {
    this.storage = runtime.storage;
    this.paths = runtime.paths;
  }

  hydrate(shards: string[]): void {
    for (const shardDir of shards) {
      this.hydrateShard(shardDir);
    }
  }

  invalidate(shardHash: string, sessionId: string): void {
    const stale = this.staleSessionIds.get(shardHash) ?? new Set<string>();
    stale.add(sessionId);
    this.staleSessionIds.set(shardHash, stale);
  }

  discoverShard(shardHash: string): void {
    if (this.shardDirs.has(shardHash)) return;
    const shardDir = join(this.paths.sessionBase(), shardHash);
    this.hydrateShard(shardDir);
  }

  hasShard(shardHash: string): boolean {
    return this.shardDirs.has(shardHash);
  }

  reread(shardHash: string, sessionId: string): void {
    const shardDir = this.resolveShardDir(shardHash);
    const sessions = this.index.get(shardHash) ?? new Map<string, LenientSessionEntry>();
    sessions.delete(sessionId);

    if (!shardDir) {
      this.index.set(shardHash, sessions);
      this.clearStale(shardHash, sessionId);
      return;
    }

    const entry = readSessionEntryLenient(join(shardDir, `${sessionId}.json`), this.storage);
    if (entry !== null) {
      sessions.set(entry.sessionId, entry);
    }

    this.index.set(shardHash, sessions);
    this.clearStale(shardHash, sessionId);
  }

  listForNamespace(namespace: string, _progressStore: ProgressStore): SessionIndexRow[] {
    this.refreshIndex();

    const results: SessionIndexRow[] = [];
    for (const [shardHash, sessions] of this.index) {
      const filtered = [...sessions.values()].filter((session) => session.backendNamespace === namespace);
      if (filtered.length > 0) {
        results.push({ shardHash, sessions: filtered });
      }
    }

    return results;
  }

  listAll(): SessionIndexRow[] {
    this.refreshIndex();

    const results: SessionIndexRow[] = [];
    for (const [shardHash, sessions] of this.index) {
      if (sessions.size > 0) {
        results.push({ shardHash, sessions: [...sessions.values()] });
      }
    }
    return results;
  }

  private refreshIndex(): void {
    // Shard discovery is event-driven via session:updated — no unconditional readdirSync.
    // Bootstrap guard: if index is completely empty, do a one-time full scan.
    if (this.shardDirs.size === 0) {
      this.hydrateUnknownShards(listSessionShards({ storage: this.storage, paths: this.paths }));
    }
    for (const [shardHash, sessionIds] of this.staleSessionIds) {
      for (const sessionId of [...sessionIds]) {
        this.reread(shardHash, sessionId);
      }
    }
  }

  private hydrateUnknownShards(shards: string[]): void {
    for (const shardDir of shards) {
      const shardHash = basename(shardDir);
      if (this.shardDirs.has(shardHash)) continue;
      this.hydrateShard(shardDir);
    }
  }

  private hydrateShard(shardDir: string): void {
    const shardHash = basename(shardDir);
    this.shardDirs.set(shardHash, shardDir);
    this.index.set(shardHash, this.readShardEntries(shardDir));
    this.staleSessionIds.delete(shardHash);
  }

  private readShardEntries(shardDir: string): Map<string, LenientSessionEntry> {
    const sessions = new Map<string, LenientSessionEntry>();
    let files: ReturnType<RuntimeStoragePort['readdirSync']>;

    try {
      files = this.storage.readdirSync(shardDir, { withFileTypes: true });
    } catch {
      return sessions;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const entry = readSessionEntryLenient(join(shardDir, file.name), this.storage);
      if (entry !== null) {
        sessions.set(entry.sessionId, entry);
      }
    }

    return sessions;
  }

  private resolveShardDir(shardHash: string): string | null {
    const known = this.shardDirs.get(shardHash);
    if (known) return known;

    this.hydrateUnknownShards(listSessionShards({ storage: this.storage, paths: this.paths }));
    return this.shardDirs.get(shardHash) ?? null;
  }

  private clearStale(shardHash: string, sessionId: string): void {
    const stale = this.staleSessionIds.get(shardHash);
    if (!stale) return;
    stale.delete(sessionId);
    if (stale.size === 0) {
      this.staleSessionIds.delete(shardHash);
    }
  }
}
