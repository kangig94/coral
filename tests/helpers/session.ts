import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { SessionManager } from '#src/sessions/shell.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import type { Database } from '#src/store/db.js';
import { reduceSessionOpened } from '#src/sessions/projections.js';
import type { SessionOpenedBody } from '#src/sessions/event-bodies.js';
import type { CoralEvent } from '#src/store/envelope.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import type { InitJobOptions } from '#src/jobs/contracts/job-store.js';
import type { JobStore } from '#src/jobs/store.js';

import { TEST_CLAUDE_SOURCE, TEST_CODEX_SOURCE } from './provider-credentials.js';

export function allocateTestSession(
  manager: Pick<SessionManager, 'allocate'>,
  provider: string,
  name: string,
  model: string | undefined,
  cwd: string,
  projectRoot = cwd,
) {
  const sessionAuthority =
    provider === 'codex'
      ? ({ kind: 'provider', source: TEST_CODEX_SOURCE } as const)
      : provider === 'claude'
        ? ({ kind: 'provider', source: TEST_CLAUDE_SOURCE } as const)
        : ({ kind: 'orchestration' } as const);
  return manager.allocate({
    provider,
    sessionAuthority,
    name,
    ...(model === undefined ? {} : { model }),
    cwd,
    projectRoot,
    backendNamespace: 'test',
  });
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
    orchestration?: boolean;
  },
): SessionEntry {
  const existing = db
    .prepare<[string], { entry: string }>('SELECT entry FROM projection_sessions WHERE session_id = ?')
    .get(options.sessionId);
  if (existing !== undefined) return JSON.parse(existing.entry) as SessionEntry;

  const source =
    options.provider === 'codex'
      ? TEST_CODEX_SOURCE
      : options.provider === 'claude'
        ? TEST_CLAUDE_SOURCE
        : undefined;
  if (!options.orchestration && source === undefined) {
    throw new Error(`Test provider session '${options.provider}' has no credential source fixture.`);
  }
  const sessionAuthority = options.orchestration
    ? ({ kind: 'orchestration' } as const)
    : source === undefined
      ? (() => {
          throw new Error(`Test provider session '${options.provider}' has no credential source fixture.`);
        })()
      : ({ kind: 'provider', source } as const);
  const now = '2026-01-01T00:00:00.000Z';
  const entry: SessionEntry = {
    sessionId: options.sessionId,
    provider: options.provider,
    sessionAuthority,
    name: options.sessionId,
    state: 'ready',
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
    entry,
    controller: 'default',
    provider: options.provider,
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
    bodyVersion: 1,
    body,
  };
  reduceSessionOpened(db, event);
  return entry;
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
    orchestration: options.jobKind === 'workflow',
  });
}
