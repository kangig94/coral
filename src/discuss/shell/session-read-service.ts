/**
 * The server composition root owns the mutable discuss registry and store
 * lookup, while this module owns the read-side query behavior.
 */

import {
  buildDiscussDetail,
  buildDiscussSummary,
  type DiscussDetailResponse,
  type DiscussSummaryDto,
  type DiscussView,
} from '../read-contract.js';
import { listAttachedSessions, type DiscussContextRegistry } from './live-registry.js';
import type { DiscussSessionStore } from './session-store.js';

export type DiscussReadHelpersDeps = {
  readonly discussRegistry: DiscussContextRegistry;
  readonly getDiscussStoreForSource: (source: string) => DiscussSessionStore;
  readonly resolveProjectSource: (projectRoot: string) => string;
  readonly readDiscussSources: () => string[];
};

function collectDiscussSources(
  deps: DiscussReadHelpersDeps,
  liveSessions: ReturnType<typeof listAttachedSessions>,
): Set<string> {
  const sources = new Set(deps.readDiscussSources());
  for (const liveSession of liveSessions) {
    sources.add(deps.resolveProjectSource(liveSession.projectRoot));
  }
  return sources;
}

export function knownDiscussSources(deps: DiscussReadHelpersDeps): Set<string> {
  return collectDiscussSources(deps, listAttachedSessions(deps.discussRegistry));
}

export function listDiscussSessions(deps: DiscussReadHelpersDeps): DiscussSummaryDto[] {
  const results = new Map<string, DiscussSummaryDto>();
  const liveSessions = listAttachedSessions(deps.discussRegistry);
  const sources = collectDiscussSources(deps, liveSessions);

  for (const source of sources) {
    for (const summary of deps.getDiscussStoreForSource(source).listSummariesFromIndex()) {
      const key = `${source}\u0000${summary.sessionId}`;
      results.set(key, summary);
    }
  }

  for (const liveSession of liveSessions) {
    const snapshot = liveSession.session.snapshot;
    const summary = buildDiscussSummary(snapshot, 'live');
    const source = deps.resolveProjectSource(liveSession.projectRoot);
    results.set(`${source}\u0000${summary.sessionId}`, summary);
  }

  return [...results.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function isLiveDiscussSession(deps: DiscussReadHelpersDeps, source: string, sessionId: string): boolean {
  for (const liveSession of listAttachedSessions(deps.discussRegistry)) {
    if (liveSession.sessionId === sessionId && deps.resolveProjectSource(liveSession.projectRoot) === source) {
      return true;
    }
  }
  return false;
}

export function loadDiscussDetail(
  deps: DiscussReadHelpersDeps,
  source: string,
  sessionId: string,
  view: DiscussView,
): DiscussDetailResponse | 'audit_requires_ended_session' | null {
  const snapshot = deps.getDiscussStoreForSource(source).load(sessionId);
  if (!snapshot) {
    return null;
  }
  if (view === 'audit' && snapshot.state.status !== 'ended') {
    return 'audit_requires_ended_session';
  }

  const authority = isLiveDiscussSession(deps, source, sessionId) ? 'live' : 'persisted';
  if (view === 'audit') {
    return buildDiscussDetail(snapshot, 'audit', authority);
  }
  return buildDiscussDetail(snapshot, 'control', authority);
}
