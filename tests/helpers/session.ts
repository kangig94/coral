import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { SessionManager } from '#src/sessions/shell.js';
import { providerSessionSchema, type ProviderSession } from '#src/sessions/entry.js';
import type { Database } from '#src/store/db.js';
import { reduceSessionClaimed, reduceSessionOpened } from '#src/sessions/projections.js';
import type { SessionClaimedBody, SessionOpenedBody } from '#src/sessions/event-bodies.js';
import type { CoralEvent } from '#src/store/envelope.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import type { InitJobOptions } from '#src/jobs/contracts/job-store.js';
import type { JobStore } from '#src/jobs/store.js';
import type {
  ContinuitySnapshot,
  ProviderContinuityBlob,
  ProviderValidatedContinuityBlob,
  ProviderValidatedContinuitySnapshot,
} from '#src/sessions/continuity.js';
import type {
  ProviderValidatedSessionContinuityMutation,
  SessionContinuityMutation,
} from '#src/sessions/continuity-mutation.js';

import { TEST_CLAUDE_BINDING, TEST_CODEX_BINDING } from './provider-credentials.js';

/** Test-only stand-in for a successful BoundProvider continuity decode. */
export function validatedTestContinuityBlob(value: ProviderContinuityBlob): ProviderValidatedContinuityBlob {
  return value as ProviderValidatedContinuityBlob;
}

/** Test-only stand-in for a snapshot assembled from a BoundProvider decode. */
export function validatedTestContinuitySnapshot(snapshot: ContinuitySnapshot): ProviderValidatedContinuitySnapshot {
  return {
    ...snapshot,
    providerContinuity:
      snapshot.providerContinuity === null ? null : validatedTestContinuityBlob(snapshot.providerContinuity),
  };
}

/** Test-only stand-in for a recovery mutation returned by BoundProvider. */
export function validatedTestContinuityMutation(
  mutation: SessionContinuityMutation,
): ProviderValidatedSessionContinuityMutation {
  if (mutation.providerContinuity === undefined) return mutation as ProviderValidatedSessionContinuityMutation;
  return { ...mutation, providerContinuity: validatedTestContinuityBlob(mutation.providerContinuity) };
}

export function allocateTestSession(
  manager: Pick<SessionManager, 'allocate'>,
  provider: string,
  name: string,
  model: string | undefined,
  cwd: string,
  projectRoot = cwd,
  backendNamespace = 'test',
) {
  const binding =
    provider === 'codex'
      ? TEST_CODEX_BINDING
      : provider === 'claude'
        ? TEST_CLAUDE_BINDING
        : (() => {
            throw new Error(`No binding fixture for '${provider}'.`);
          })();
  return manager.allocate({
    binding,
    name,
    ...(model === undefined ? {} : { model }),
    cwd,
    projectRoot,
    backendNamespace,
  });
}

/** Test-only fixture writer. Production continuity reaches this atomic port only after BoundProvider decoding. */
export async function seedTestProviderContinuity(
  manager: Pick<SessionManager, 'claimForJobSync' | 'readById' | 'checkpointJobContinuityAtomic' | 'releaseJob'>,
  sessionId: string,
  update: { providerContinuity: ProviderContinuityBlob; conversationRef: string },
): Promise<void> {
  await seedTestSessionContinuity(manager, sessionId, {
    conversationRef: update.conversationRef,
    resumable: true,
    providerContinuity: update.providerContinuity,
  });
}

/** Test-only fixture writer for an unclaimed session. */
export async function seedTestSessionContinuity(
  manager: Pick<SessionManager, 'claimForJobSync' | 'readById' | 'checkpointJobContinuityAtomic' | 'releaseJob'>,
  sessionId: string,
  snapshot: ContinuitySnapshot,
): Promise<void> {
  const fixtureJobId = `continuity-fixture-${sessionId}`;
  manager.claimForJobSync(sessionId, fixtureJobId);
  try {
    await checkpointClaimedTestContinuity(manager, sessionId, fixtureJobId, snapshot);
  } finally {
    manager.releaseJob(sessionId, fixtureJobId);
  }
}

/** Test-only fixture writer for a session whose job claim is intentionally retained. */
export async function checkpointClaimedTestContinuity(
  manager: Pick<SessionManager, 'readById' | 'checkpointJobContinuityAtomic'>,
  sessionId: string,
  jobId: string,
  snapshot: ContinuitySnapshot,
): Promise<void> {
  const claimed = manager.readById(sessionId, { forceFresh: true });
  if (claimed === null) throw new Error(`Missing test session '${sessionId}'.`);
  if (claimed.activeJobId !== jobId) {
    throw new Error(`Test session '${sessionId}' is not claimed by '${jobId}'.`);
  }
  const result = await manager.checkpointJobContinuityAtomic(sessionId, {
    expectedActiveJobId: jobId,
    expectedVersion: claimed.version,
    snapshot: validatedTestContinuitySnapshot(snapshot),
  });
  if (!result.ok) throw new Error(`Could not seed test continuity for '${sessionId}'.`);
}

function testSessionScopeKey(projectRoot: string): string {
  try {
    return pluginRootNamespace(projectRoot);
  } catch {
    return createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 12);
  }
}

export function seedTestSessionProjection(
  db: Database,
  options: {
    sessionId: string;
    provider: string;
    projectRoot: string;
    backendNamespace?: string;
    activeJobId?: string;
  },
): ProviderSession {
  const existing = db
    .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
    .get(options.sessionId);
  if (existing !== undefined) {
    const entry = providerSessionSchema.parse(JSON.parse(existing.entry));
    if (options.activeJobId !== undefined && entry.activeJobId !== options.activeJobId) {
      const claimed = { ...entry, activeJobId: options.activeJobId, version: entry.version + 1 };
      reduceSessionClaimed(db, {
        seq: 1,
        ts: entry.lastUsedAt,
        type: 'session.claimed',
        stream: { kind: 'session', id: options.sessionId },
        namespace: options.backendNamespace,
        project: options.projectRoot,
        refs: { sessionId: options.sessionId, jobId: options.activeJobId },
        body: { entry: claimed, jobId: options.activeJobId },
      });
      return claimed;
    }
    return entry;
  }

  const binding =
    options.provider === 'codex' ? TEST_CODEX_BINDING : options.provider === 'claude' ? TEST_CLAUDE_BINDING : undefined;
  if (binding === undefined) {
    throw new Error(`Test provider session '${options.provider}' has no binding fixture.`);
  }
  const now = '2026-01-01T00:00:00.000Z';
  const opened: ProviderSession = {
    sessionId: options.sessionId,
    binding,
    name: options.sessionId,
    state: 'pending',
    retention: 'retain',
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    providerContinuity: null,
    cwd: options.projectRoot,
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace ?? 'tests',
    createdAt: now,
    lastUsedAt: now,
    version: 1,
  };
  const body: SessionOpenedBody = {
    entry: opened,
    controller: 'default',
    scope_key: testSessionScopeKey(options.projectRoot),
  };
  const event: CoralEvent<SessionOpenedBody> = {
    seq: 0,
    ts: now,
    type: 'session.opened',
    stream: { kind: 'session', id: options.sessionId },
    namespace: options.backendNamespace,
    project: options.projectRoot,
    refs: { sessionId: options.sessionId },
    body,
  };
  reduceSessionOpened(db, event);
  if (options.activeJobId === undefined) {
    return opened;
  }
  const claimed: ProviderSession = {
    ...opened,
    activeJobId: options.activeJobId,
    version: opened.version + 1,
  };
  const claimBody: SessionClaimedBody = { entry: claimed, jobId: options.activeJobId };
  reduceSessionClaimed(db, {
    ...event,
    seq: 1,
    type: 'session.claimed',
    refs: { sessionId: options.sessionId, jobId: options.activeJobId },
    body: claimBody,
  });
  return claimed;
}

export function initTestJob(store: JobStore, options: InitJobOptions): void {
  seedTestJobSession(store, options);
  store.initJob(options);
}

export function seedTestJobSession(store: JobStore, options: InitJobOptions): void {
  seedTestSessionProjection(store.getDb(), {
    sessionId: options.sessionId,
    provider: options.provider,
    projectRoot: options.projectRoot,
    backendNamespace: options.backendNamespace,
    activeJobId: options.jobId,
  });
}
