import type { Runtime } from '../runtime/ports.js';
import { listSessionShards, readSessionRefs } from './shell/resolve.js';

export type SessionLookupRef = {
  sessionId: string;
  provider: string;
  shardDir: string;
};

export interface SessionLookup {
  listSessionRefs(): SessionLookupRef[];
  lookupSessionShard(sessionId: string): { shardDir: string; provider: string } | null;
}

type SessionLookupRuntime = Pick<Runtime, 'storage' | 'paths'>;

export function createFilesystemSessionLookup(runtime: SessionLookupRuntime): SessionLookup {
  return {
    listSessionRefs(): SessionLookupRef[] {
      return listSessionShards(runtime).flatMap((shardDir) =>
        readSessionRefs(shardDir, runtime.storage).map((ref) => ({
          ...ref,
          shardDir,
        })),
      );
    },
    lookupSessionShard(sessionId: string): { shardDir: string; provider: string } | null {
      for (const shardDir of listSessionShards(runtime)) {
        const match = readSessionRefs(shardDir, runtime.storage).find((ref) => ref.sessionId === sessionId);
        if (match) {
          return {
            shardDir,
            provider: match.provider,
          };
        }
      }

      return null;
    },
  };
}

export function mergeSessionLookups(primary: SessionLookup, fallback: SessionLookup): SessionLookup {
  return {
    listSessionRefs(): SessionLookupRef[] {
      const refsBySessionId = new Map<string, SessionLookupRef>();
      for (const ref of primary.listSessionRefs()) {
        refsBySessionId.set(ref.sessionId, ref);
      }
      for (const ref of fallback.listSessionRefs()) {
        if (!refsBySessionId.has(ref.sessionId)) {
          refsBySessionId.set(ref.sessionId, ref);
        }
      }
      return [...refsBySessionId.values()];
    },
    lookupSessionShard(sessionId: string): { shardDir: string; provider: string } | null {
      return primary.lookupSessionShard(sessionId) ?? fallback.lookupSessionShard(sessionId);
    },
  };
}
