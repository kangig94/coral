import { join } from 'node:path';

import { isNoEntryError, isRecord } from '../../shared/utils.js';
import type { Runtime } from '../../runtime/ports.js';
import type { SessionEntry } from '../entry.js';
import { SessionManager } from './store.js';

type SessionRuntime = Pick<Runtime, 'storage' | 'paths' | 'time' | 'ids'>;

export type SessionResolveRef =
  | string
  | {
      sessionId: string;
      provider?: string;
      shardDir?: string;
    };

export function listSessionShards(runtime: Pick<Runtime, 'storage' | 'paths'>): string[] {
  const sessionsRoot = runtime.paths.sessionBase();
  try {
    return runtime.storage
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsRoot, entry.name));
  } catch {
    return [];
  }
}

export function readSessionRefs(
  shardDir: string,
  storage: Pick<Runtime['storage'], 'readdirSync' | 'readFileSync'>,
): Array<{ sessionId: string; provider: string }> {
  try {
    return storage
      .readdirSync(shardDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .flatMap((entry) => {
        try {
          const raw = storage.readFileSync(join(shardDir, entry.name), 'utf-8');
          const parsed: unknown = JSON.parse(raw);
          if (!isRecord(parsed)) return [];
          if (typeof parsed.sessionId !== 'string' || typeof parsed.provider !== 'string') return [];
          return [{ sessionId: parsed.sessionId, provider: parsed.provider }];
        } catch (error: unknown) {
          if (isNoEntryError(error) || error instanceof SyntaxError) return [];
          throw error;
        }
      });
  } catch (error: unknown) {
    if (isNoEntryError(error)) return [];
    throw error;
  }
}

export function resolveSession(
  ref: SessionResolveRef,
  runtime: SessionRuntime,
): SessionEntry | null {
  const target = typeof ref === 'string' ? { sessionId: ref } : ref;

  if (target.shardDir) {
    const sessionManager = SessionManager.openShard(target.shardDir, runtime);
    const entry = target.provider
      ? sessionManager.get(target.provider, target.sessionId)
      : sessionManager.readById(target.sessionId, { forceFresh: true });
    return entry ?? null;
  }

  for (const shardDir of listSessionShards(runtime)) {
    const entry = resolveSession({ ...target, shardDir }, runtime);
    if (entry) {
      return entry;
    }
  }

  return null;
}

export function getSessionById(
  sessionId: string,
  runtime: SessionRuntime,
): SessionEntry | null {
  return resolveSession({ sessionId }, runtime);
}
