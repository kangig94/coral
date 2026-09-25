import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  prepareDurableCliTransfer,
  prepareDurableCliRecoveryGrant,
  readDurableCliControllerReceipts,
  recordDurableCliControllerReceipts,
  verifyDurableCliTransfer,
  verifyDurableCliRecoveryGrant,
} from '#src/coordinator/services/durable-cli-transfer.js';
import { bindCustodyIdentity, recordCustodyIntent } from '#src/store/custody-ledger.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { deleteDurableCliProcessRuntimeMeta, writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import type { ResolvedStoreEpoch } from '#src/store/epoch.js';
import { readOrCreateEpochKey } from '#src/store/epoch-key.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { JobStore } from '#src/jobs/store.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { encodeHistoricalDurableCliProcessRuntimeMeta } from '#tests/helpers/historical-durable-cli-runtime-meta.js';

const JOB_ID = '00000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000002';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'coral-durable-transfer-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  const runDir = join(root, 'run');
  const epochPath = join(root, 'epoch-1', 'store.db');
  mkdirSync(dirname(epochPath));
  writeFileSync(join(dirname(epochPath), '.lock'), '');
  const epoch = {
    storeRoot: root,
    epoch: '1',
    path: epochPath,
    lineageKey: readOrCreateEpochKey(runtime, { storeRoot: root, epoch: '1', path: epochPath }),
  } satisfies ResolvedStoreEpoch;
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const meta = {
    jobId: JOB_ID,
    pid: 4242,
    incarnation: testIncarnation(1),
    processGroupId: 4242,
    childRoot: { pid: 4243, incarnation: testIncarnation(2) },
  };
  writeDurableCliProcessRuntimeMeta(db, meta);
  const progressStore = {
    readRuntimeProjection: (jobId: string) =>
      jobId === JOB_ID
        ? {
            transport: 'durable-cli' as const,
            pid: 4242,
            stdoutPath: join(root, 'stdout.log'),
            stderrPath: join(root, 'stderr.log'),
            startTime: new Date(0).toISOString(),
          }
        : null,
  } as Pick<JobStore, 'readRuntimeProjection'>;
  return { root, runDir, epoch, db, meta, progressStore, runtime };
}

describe('durable-cli succession transfer', () => {
  it('should hold a live wrapper until its current runtime generation and pre-effect custody binding agree', () => {
    const { runDir, epoch, db, meta, progressStore, runtime } = fixture();
    expect(prepareDurableCliTransfer(runtime, db, progressStore, runDir, epoch, [JOB_ID])).toBeNull();

    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: dirname(epoch.path),
      owner: 'durable-cli',
      operationId: JOB_ID,
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1_000,
    });
    expect(prepareDurableCliTransfer(runtime, db, progressStore, runDir, epoch, [JOB_ID])).toBeNull();
    bindCustodyIdentity(runtime, runDir, intent, {
      process: { pid: meta.pid, incarnation: meta.incarnation, processGroupId: meta.processGroupId },
      capsule: null,
      observedAtMs: 200,
    });
    const transfer = prepareDurableCliTransfer(runtime, db, progressStore, runDir, epoch, [JOB_ID]);
    expect(transfer?.jobs).toMatchObject([{ jobId: JOB_ID, custodyIntentId: intent.id }]);
    expect(verifyDurableCliTransfer(runtime, transfer, db, progressStore, runDir, epoch)).toEqual(transfer);
    if (transfer === null) throw new Error('Expected a bound durable-cli transfer.');
    const epochKey = JSON.stringify(epoch);
    const grantId = prepareDurableCliRecoveryGrant(runtime, runDir, {
      version: 'v1',
      attemptId: ATTEMPT_ID,
      epochKey,
      incumbentInstanceId: 'incumbent',
      incumbentBuildSetId: 'build-1',
      transfer,
    });
    expect(verifyDurableCliRecoveryGrant(runtime, runDir, ATTEMPT_ID, grantId, epochKey, 'incumbent', transfer)).toBe(
      true,
    );
    expect(
      verifyDurableCliRecoveryGrant(runtime, runDir, ATTEMPT_ID, grantId, 'other-epoch', 'incumbent', transfer),
    ).toBe(false);
    expect(
      verifyDurableCliTransfer(runtime, transfer, db, progressStore, runDir, {
        ...epoch,
        path: join(epoch.storeRoot, 'epoch-2', 'store.db'),
      }),
    ).toBeNull();
    db.close();
  });

  it('should retain an epoch-bound acknowledged controller receipt for each accepted job', () => {
    const { runDir, epoch, db, meta, progressStore, runtime } = fixture();
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: dirname(epoch.path),
      owner: 'durable-cli',
      operationId: JOB_ID,
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1_000,
    });
    bindCustodyIdentity(runtime, runDir, intent, {
      process: { pid: meta.pid, incarnation: meta.incarnation, processGroupId: meta.processGroupId },
      capsule: null,
      observedAtMs: 200,
    });
    const transfer = prepareDurableCliTransfer(runtime, db, progressStore, runDir, epoch, [JOB_ID]);
    if (transfer === null) throw new Error('Expected a bound durable-cli transfer.');
    const controller = {
      epochKey: JSON.stringify(epoch),
      attemptId: ATTEMPT_ID,
      instanceId: 'successor',
      buildSetId: 'build-2',
      generation: 2,
      nowMs: 300,
    };
    recordDurableCliControllerReceipts(runtime, runDir, transfer, controller);
    recordDurableCliControllerReceipts(runtime, runDir, transfer, controller);
    expect(readDurableCliControllerReceipts(runtime, runDir)).toMatchObject([
      {
        jobId: JOB_ID,
        epochKey: controller.epochKey,
        controllerInstanceId: 'successor',
        controlGeneration: 2,
        runtimeRecordGeneration: 2,
        custodyIntentId: intent.id,
      },
    ]);
    db.close();
  });

  it('verifies a committed transfer after its epoch moved to a protected address', () => {
    const { root, runDir, epoch, db, meta, progressStore, runtime } = fixture();
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: dirname(epoch.path),
      owner: 'durable-cli',
      operationId: JOB_ID,
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1_000,
    });
    bindCustodyIdentity(runtime, runDir, intent, {
      process: { pid: meta.pid, incarnation: meta.incarnation, processGroupId: meta.processGroupId },
      capsule: null,
      observedAtMs: 200,
    });
    const transfer = prepareDurableCliTransfer(runtime, db, progressStore, runDir, epoch, [JOB_ID]);
    const protectedEpoch: ResolvedStoreEpoch = {
      storeRoot: join(root, '.protected', 'lineage'),
      canonicalStoreRoot: root,
      epoch: '1',
      path: join(root, '.protected', 'lineage', 'epoch-1', 'store.db'),
      lineageKey: epoch.lineageKey,
    };
    expect(verifyDurableCliTransfer(runtime, transfer, db, progressStore, runDir, protectedEpoch)).toEqual(transfer);
    db.close();
  });

  it('should block predecessor runtime records even when a process identity is bound', () => {
    const { runDir, epoch, db, meta, progressStore, runtime } = fixture();
    const intent = recordCustodyIntent(runtime, runDir, {
      effect: 'process-spawn',
      epoch: dirname(epoch.path),
      owner: 'durable-cli',
      operationId: JOB_ID,
      capsule: null,
      nowMs: 100,
      bindWithinMs: 1_000,
    });
    bindCustodyIdentity(runtime, runDir, intent, {
      process: { pid: meta.pid, incarnation: meta.incarnation, processGroupId: meta.processGroupId },
      capsule: null,
      observedAtMs: 200,
    });
    deleteDurableCliProcessRuntimeMeta(db, JOB_ID);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      `durable_cli_process.v1:${JOB_ID}`,
      encodeHistoricalDurableCliProcessRuntimeMeta({
        version: 1,
        jobId: JOB_ID,
        pid: meta.pid,
        incarnation: meta.incarnation,
      }),
    );
    expect(prepareDurableCliTransfer(runtime, db, progressStore, runDir, epoch, [JOB_ID])).toBeNull();
    db.close();
  });
});
