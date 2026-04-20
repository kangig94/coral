import type { Runtime } from '../runtime/ports.js';
import type { SessionCloseReason, SessionInterruptedFault } from './fault.js';
import type { SessionEntry, SessionHandle } from './entry.js';
import type { ContinuitySnapshot } from './continuity.js';
import type { SessionLookup } from './lookup.js';
import { resolveSession, type SessionResolveRef } from './shell/resolve.js';
import { type SessionAllocateOptions, type SessionManager } from './shell/store.js';

type SessionRuntime = Pick<Runtime, 'storage' | 'paths' | 'time' | 'ids'>;

export type SessionListFilter = {
  provider: string;
};

export const sessionsCommands = {
  open(store: Pick<SessionManager, 'open'>, args: SessionAllocateOptions): SessionHandle {
    return store.open(args);
  },
  checkpoint(
    store: Pick<SessionManager, 'checkpoint'>,
    sessionId: string,
    snapshot: ContinuitySnapshot,
  ): void {
    store.checkpoint(sessionId, snapshot);
  },
  interrupt(
    store: Pick<SessionManager, 'interrupt'>,
    sessionId: string,
    fault: SessionInterruptedFault,
  ): void {
    store.interrupt(sessionId, fault);
  },
  close(
    store: Pick<SessionManager, 'close'>,
    sessionId: string,
    reason: SessionCloseReason,
  ): void {
    store.close(sessionId, reason);
  },
} as const;

export const sessionsQueries = {
  get(store: Pick<SessionManager, 'readById'>, id: string): SessionEntry | undefined {
    return store.readById(id, { forceFresh: true }) ?? undefined;
  },
  list(store: Pick<SessionManager, 'list'>, filter: SessionListFilter): SessionEntry[] {
    return store.list(filter.provider);
  },
  resolve(
    runtime: SessionRuntime,
    ref: SessionResolveRef,
    sessionLookup: Pick<SessionLookup, 'lookupSessionShard'>,
  ): SessionEntry | undefined {
    return resolveSession(ref, runtime, sessionLookup) ?? undefined;
  },
} as const;

export type { SessionEntry } from './entry.js';
export type { SessionAllocateOptions, SessionManager } from './shell/store.js';
