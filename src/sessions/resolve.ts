import { providerSessionProvider, type ProviderSession } from './entry.js';
import type { SessionLookup } from './lookup.js';

export type SessionResolveRef =
  | string
  | {
      sessionId: string;
      provider?: string;
    };

export function resolveSession(
  ref: SessionResolveRef,
  sessionLookup: Pick<SessionLookup, 'readProviderSession'>,
): ProviderSession | null {
  const target = typeof ref === 'string' ? { sessionId: ref } : ref;
  const entry = sessionLookup.readProviderSession(target.sessionId);
  if (!entry) {
    return null;
  }
  if (target.provider && providerSessionProvider(entry) !== target.provider) {
    return null;
  }
  return entry;
}

export function getSessionById(
  sessionId: string,
  sessionLookup: Pick<SessionLookup, 'readProviderSession'>,
): ProviderSession | null {
  return resolveSession({ sessionId }, sessionLookup);
}
