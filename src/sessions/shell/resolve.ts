import type { Runtime } from '../../runtime/ports.js';
import type { SessionEntry } from '../entry.js';
import type { SessionLookup } from '../lookup-contract.js';

type SessionRuntime = Pick<Runtime, 'storage' | 'paths' | 'time' | 'ids'>;

export type SessionResolveRef =
  | string
  | {
      sessionId: string;
      provider?: string;
    };

export function resolveSession(
  ref: SessionResolveRef,
  _runtime: SessionRuntime,
  sessionLookup: Pick<SessionLookup, 'readSessionEntry'>,
): SessionEntry | null {
  const target = typeof ref === 'string' ? { sessionId: ref } : ref;
  const entry = sessionLookup.readSessionEntry(target.sessionId);
  if (!entry) {
    return null;
  }
  if (target.provider && entry.provider !== target.provider) {
    return null;
  }
  return entry;
}

export function getSessionById(
  sessionId: string,
  runtime: SessionRuntime,
  sessionLookup: Pick<SessionLookup, 'readSessionEntry'>,
): SessionEntry | null {
  return resolveSession({ sessionId }, runtime, sessionLookup);
}
