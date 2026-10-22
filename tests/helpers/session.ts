import type { ConversationManager } from '#src/jobs/conversation/shell.js';
import type { JobConversation } from '#src/jobs/conversation/entry.js';
import type { Database } from '#src/store/db.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/read-queries.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { jobConversationFacetSchema, type JobOpenedBody } from '#src/jobs/launch.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { fixtureCanonicalWorkDir } from './canonical-work-dir.js';
import { commitInputs } from './commit-inputs.js';
import { permissiveProviderLookupPort } from './append-context.js';
import type { InitJobOptions } from '#src/jobs/contracts/job-store.js';
import type { JobStore } from '#src/jobs/store.js';
import type {
  ContinuitySnapshot,
  ProviderContinuityBlob,
  ProviderValidatedContinuityBlob,
  ProviderValidatedContinuitySnapshot,
} from '#src/jobs/conversation/continuity.js';
import type {
  ProviderValidatedSessionContinuityMutation,
  SessionContinuityMutation,
} from '#src/jobs/conversation/continuity-mutation.js';

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
  manager: Pick<ConversationManager, 'prepare'>,
  provider: string,
  name: string,
  model: string | undefined,
  cwd: string,
  projectRoot = cwd,
  backendNamespace = 'test',
) {
  return manager.prepare({
    binding: testProviderBinding(provider),
    name,
    ...(model === undefined ? {} : { model }),
    cwd: fixtureCanonicalWorkDir(cwd),
    projectRoot,
    backendNamespace,
  });
}

function testProviderBinding(provider: string) {
  if (provider === 'codex') return TEST_CODEX_BINDING;
  if (provider === 'claude') return TEST_CLAUDE_BINDING;
  throw new Error(`No binding fixture for '${provider}'.`);
}

export function testConversationFacet(provider = 'codex', cwd = '/tmp/project') {
  return jobConversationFacetSchema.parse({
    provider,
    binding: testProviderBinding(provider),
    cwd: fixtureCanonicalWorkDir(cwd),
    name: 'test-conversation',
    bypassPermissions: false,
    retention: 'retain',
  });
}

export function testJobConversation(jobId: string, overrides: Partial<JobConversation> = {}): JobConversation {
  const binding = overrides.binding ?? TEST_CODEX_BINDING;
  return {
    jobId,
    execution: 0,
    open: false,
    finishing: false,
    provider: binding.provider,
    binding,
    name: jobId,
    retention: 'retain',
    bypassPermissions: false,
    artifactHandles: [],
    retentionDiscard: { attempts: [] },
    providerContinuity: null,
    cwd: fixtureCanonicalWorkDir('/tmp/project'),
    projectRoot: '/tmp/project',
    backendNamespace: 'tests',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function testConversationOpenedInput(entry: JobConversation): CoralEventInput<JobOpenedBody> {
  const {
    jobId: _jobId,
    execution: _execution,
    open: _open,
    finishing: _finishing,
    conversationRef: _conversationRef,
    providerContinuity: _providerContinuity,
    artifactHandles: _artifactHandles,
    retentionDiscard: _retentionDiscard,
    projectRoot: _projectRoot,
    backendNamespace: _backendNamespace,
    createdAt: _createdAt,
    lastUsedAt: _lastUsedAt,
    ...facet
  } = entry;
  const conversation = jobConversationFacetSchema.parse(facet);
  return {
    type: 'job.opened',
    stream: { kind: 'job', id: entry.jobId },
    refs: { jobId: entry.jobId },
    project: entry.projectRoot,
    body: {
      jobKind: 'provider',
      owner: { kind: 'provider-session', id: entry.jobId },
      projectRoot: entry.projectRoot,
      createdAt: entry.createdAt,
      conversation,
    },
  };
}

export function seedTestSessionProjection(
  db: Database,
  options: {
    jobId: string;
    provider: string;
    projectRoot: string;
    backendNamespace?: string;
  },
): JobConversation {
  const existing = readProjectionJobConversation(db, options.jobId);
  if (existing !== null) return existing;
  const entry = testJobConversation(options.jobId, {
    binding: testProviderBinding(options.provider),
    provider: options.provider,
    projectRoot: options.projectRoot,
    cwd: fixtureCanonicalWorkDir(options.projectRoot),
    backendNamespace: options.backendNamespace ?? 'tests',
  });
  commitInputs(db, [testConversationOpenedInput(entry)], {
    now: () => new Date(entry.createdAt),
    reducers: composeReducers(jobsRegistry),
    bodyCodec: createEventBodyCodec(),
    providers: permissiveProviderLookupPort,
  });
  const persisted = readProjectionJobConversation(db, options.jobId);
  if (persisted === null) throw new Error(`Expected opened provider job ${options.jobId}.`);
  return persisted;
}

export function initTestJob(store: JobStore, options: InitJobOptions): void {
  store.initJob(options);
}

export function seedTestJobSession(store: JobStore, options: InitJobOptions): void {
  if (readProjectionJobConversation(store.getDb(), options.jobId) !== null) return;
  store.commit((commit) => {
    commit.append(
      testConversationOpenedInput(
        testJobConversation(options.jobId, {
          ...options.conversation,
          projectRoot: options.projectRoot,
          backendNamespace: options.backendNamespace,
        }),
      ),
    );
    return undefined;
  });
}
