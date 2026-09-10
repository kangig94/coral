import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCoordinatorJobSettlementRefusalRecorder } from '#src/coordinator/services/recovery/index.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { JobStore } from '#src/jobs/store.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { COORDINATOR_JOB_RECOVERY_BOUNDARY } from '#src/recovery/source-registry.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';

function seededJob() {
  const runtime = createRealRuntime('prod');
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const store = new JobStore('settlement-refusal-test', runtime, createEventBodyCodec(), {
    db,
    providers: permissiveProviderLookupPort,
  });
  const jobId = randomUUID();
  const sessionId = randomUUID();
  seedTestSessionProjection(db, {
    sessionId,
    provider: 'codex',
    projectRoot: '/tmp/settlement-refusal-test',
    backendNamespace: 'settlement-refusal-test',
    activeJobId: jobId,
  });
  store.appendLaunchRequested(jobId, {
    jobId,
    owner: { kind: 'provider-session', id: sessionId },
    sessionId,
    provider: 'codex',
    projectRoot: '/tmp/settlement-refusal-test',
    backendNamespace: 'settlement-refusal-test',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 1,
    providerAction: 'exec',
    request: {
      prompt: 'test',
      cwd: '/tmp/settlement-refusal-test',
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: '2026-09-10T00:00:00.000Z',
  });
  return { db, jobId, runtime };
}

describe('coordinator job settlement-refusal recorder', () => {
  it('records the canonical registered-source subject', async () => {
    const { db, jobId, runtime } = seededJob();
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    const recorder = createCoordinatorJobSettlementRefusalRecorder({
      getDb: () => db,
      isBoundaryRegistered: (boundary) => boundary === COORDINATOR_JOB_RECOVERY_BOUNDARY,
      upsert: (write) => quarantine.upsert(write),
    });

    await expect(
      recorder.record({ jobId, cause: 'terminal-persist-failed', failure: 'terminal store unavailable' }),
    ).resolves.toBe(true);
    expect(quarantine.read(COORDINATOR_JOB_RECOVERY_BOUNDARY, jobId)).toEqual({
      boundary: COORDINATOR_JOB_RECOVERY_BOUNDARY,
      subject: { key: jobId, revision: { kind: 'fingerprint', value: expect.any(String) } },
      state: 'active',
    });
    db.close();
  });

  it('surfaces a second write failure instead of claiming the refusal was recorded', async () => {
    const { db, jobId } = seededJob();
    const recorder = createCoordinatorJobSettlementRefusalRecorder({
      getDb: () => db,
      isBoundaryRegistered: () => true,
      upsert: () => false,
    });

    await expect(
      recorder.record({ jobId, cause: 'claim-release-failed', failure: 'claim store unavailable' }),
    ).rejects.toThrow('recovery quarantine write did not persist');
    db.close();
  });

  it('records a reassigned claim as durable recovery work', async () => {
    const { db, jobId, runtime } = seededJob();
    const quarantine = new RecoveryQuarantineStore(db, runtime.time);
    const recorder = createCoordinatorJobSettlementRefusalRecorder({
      getDb: () => db,
      isBoundaryRegistered: (boundary) => boundary === COORDINATOR_JOB_RECOVERY_BOUNDARY,
      upsert: (write) => quarantine.upsert(write),
    });

    await expect(
      recorder.record({
        jobId,
        cause: 'claim-already-reassigned',
        failure: 'the claim belongs to its successor',
      }),
    ).resolves.toBe(true);
    expect(quarantine.list()).toEqual([
      expect.objectContaining({
        boundary: COORDINATOR_JOB_RECOVERY_BOUNDARY,
        subject: { key: jobId, revision: { kind: 'fingerprint', value: expect.any(String) } },
        state: 'active',
        stage: 'settle',
        errorMessage: 'the claim belongs to its successor',
        detail: 'Job settlement refused after claim-already-reassigned.',
      }),
    ]);
    db.close();
  });
});
