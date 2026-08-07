import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { probeProcessStartedAtSeconds } from '#src/infra/node-process.js';
import { writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import {
  admittedByThisCoordinator,
  createObserveCarriers,
  type LocalCarrierRegistries,
} from '#src/coordinator/composition/carrier-observation.js';
import type { JobProjectionDetail } from '#src/jobs/read-queries.js';
import type { JobRuntime, JobStatus } from '#src/jobs/records.js';

const PLATFORM = process.platform;
// Guaranteed to name no process this OS ever assigns, so both the OS start-time probe and the alive check
// answer "nothing there" without depending on what else happens to be running.
const DEAD_PID = 2_147_483_647;
// `durable_cli_process.v1` keys on a canonical UUID.
const DURABLE_JOB_ID = '00000000-0000-4000-8000-000000000099';

function status(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    jobId: 'job-1',
    owner: { kind: 'provider-session', id: 'session-1' },
    sessionId: 'session-1',
    provider: 'codex',
    projectRoot: '/tmp/project',
    backendNamespace: 'test-ns',
    jobKind: 'provider',
    phase: 'running',
    updatedAt: '2026-04-19T00:00:00.000Z',
    ...overrides,
  };
}

function detail(runtime: JobRuntime | null, statusOverrides: Partial<JobStatus> = {}): JobProjectionDetail {
  return { status: status(statusOverrides), launch: null, runtime, exit: null };
}

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function registriesFor(
  details: ReadonlyMap<string, JobProjectionDetail>,
  overrides: Partial<LocalCarrierRegistries> = {},
): LocalCarrierRegistries {
  return {
    getDb: () => {
      throw new Error('getDb() not stubbed for this test');
    },
    loadJobProjectionDetail: (jobId) => details.get(jobId) ?? { status: null, launch: null, runtime: null, exit: null },
    platform: PLATFORM,
    isAdmittedByThisCoordinator: () => false,
    ...overrides,
  };
}

describe('admittedByThisCoordinator', () => {
  it('is true for a job in the active set', () => {
    const runtime = createRealRuntime('prod');
    const launchCoordinator = new LaunchCoordinator({ runtime });
    launchCoordinator.requestLaunch('active-job', 'codex', { kind: 'provider-session', id: 'session-1' });

    expect(admittedByThisCoordinator(launchCoordinator, 'active-job')).toBe(true);
  });

  it('is true for a job only in the queue', () => {
    const runtime = createRealRuntime('prod');
    const launchCoordinator = new LaunchCoordinator({ runtime });
    launchCoordinator.restoreQueuedLaunch('queued-job', 'codex', { kind: 'provider-session', id: 'session-2' });

    expect(admittedByThisCoordinator(launchCoordinator, 'queued-job')).toBe(true);
  });

  it('is false for a job this coordinator process never admitted', () => {
    const runtime = createRealRuntime('prod');
    const launchCoordinator = new LaunchCoordinator({ runtime });

    expect(admittedByThisCoordinator(launchCoordinator, 'never-admitted-job')).toBe(false);
  });
});

describe('createObserveCarriers', () => {
  it('skips a job with no stored status rather than reporting on it', async () => {
    const registries = registriesFor(new Map());
    const observe = createObserveCarriers(registries, () => 7);

    expect(await observe(['missing-job'])).toEqual([]);
  });

  it('reports queued-or-launching as live only when this coordinator admitted it', async () => {
    const details = new Map([['job-1', detail(null, { phase: 'queued' })]]);
    const admitted = createObserveCarriers(
      registriesFor(details, { isAdmittedByThisCoordinator: () => true }),
      () => 7,
    );
    const notAdmitted = createObserveCarriers(
      registriesFor(details, { isAdmittedByThisCoordinator: () => false }),
      () => 7,
    );

    expect(await admitted(['job-1'])).toEqual([
      { jobId: 'job-1', liveness: 'live', storedPhase: 'queued', observedMaxJournalSeq: 7 },
    ]);
    expect(await notAdmitted(['job-1'])).toEqual([
      { jobId: 'job-1', liveness: 'unknown', storedPhase: 'queued', observedMaxJournalSeq: 7 },
    ]);
  });

  it('reports app-server-acquired as unknown regardless of admission — no local activation registry exists yet', async () => {
    const acquiredRuntime: JobRuntime = {
      transport: 'app-server',
      startTime: '2026-04-19T00:00:00.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        hostRef: { provider: 'codex', fingerprint: 'f', instanceId: 'i', leaseMode: 'shared' },
      },
    };
    const details = new Map([['job-1', detail(acquiredRuntime)]]);
    const observe = createObserveCarriers(registriesFor(details, { isAdmittedByThisCoordinator: () => true }), () => 7);

    expect(await observe(['job-1'])).toEqual([
      { jobId: 'job-1', liveness: 'unknown', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });

  it('reports a durable CLI job as unknown when nothing was captured at launch', async () => {
    const runtime: JobRuntime = {
      transport: 'durable-cli',
      pid: DEAD_PID,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startTime: '2026-04-19T00:00:00.000Z',
    };
    const details = new Map([[DURABLE_JOB_ID, detail(runtime)]]);
    const db = createDb();
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 7);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'unknown', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });

  it('reports a durable CLI job as unknown when the recorded meta pid disagrees with the journal', async () => {
    const runtime: JobRuntime = {
      transport: 'durable-cli',
      pid: 111,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startTime: '2026-04-19T00:00:00.000Z',
    };
    const details = new Map([[DURABLE_JOB_ID, detail(runtime)]]);
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, { version: 1, jobId: DURABLE_JOB_ID, pid: 222, processStartedAtSeconds: 1 });
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 7);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'unknown', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });

  it('reports a durable CLI job as absent once its recorded process is confirmed gone — purely from local evidence', async () => {
    const runtime: JobRuntime = {
      transport: 'durable-cli',
      pid: DEAD_PID,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startTime: '2026-04-19T00:00:00.000Z',
    };
    const details = new Map([[DURABLE_JOB_ID, detail(runtime, { phase: 'running' })]]);
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, {
      version: 1,
      jobId: DURABLE_JOB_ID,
      pid: DEAD_PID,
      processStartedAtSeconds: 1,
    });
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 9);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'absent', storedPhase: 'running', observedMaxJournalSeq: 9 },
    ]);
  });

  it('reports a durable CLI job as live when the recorded pid and start second both still match', async () => {
    const ownStartedAt = probeProcessStartedAtSeconds(process.pid, PLATFORM);
    // Only the current test process's own pid is guaranteed alive and probeable from this test.
    if (ownStartedAt === null) return;
    const runtime: JobRuntime = {
      transport: 'durable-cli',
      pid: process.pid,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startTime: '2026-04-19T00:00:00.000Z',
    };
    const details = new Map([[DURABLE_JOB_ID, detail(runtime)]]);
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, {
      version: 1,
      jobId: DURABLE_JOB_ID,
      pid: process.pid,
      processStartedAtSeconds: ownStartedAt,
    });
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 7);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'live', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });

  it('reports a durable CLI job as absent when the pid is alive but its start second no longer matches — a recycled pid', async () => {
    const ownStartedAt = probeProcessStartedAtSeconds(process.pid, PLATFORM);
    if (ownStartedAt === null) return;
    const runtime: JobRuntime = {
      transport: 'durable-cli',
      pid: process.pid,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startTime: '2026-04-19T00:00:00.000Z',
    };
    const details = new Map([[DURABLE_JOB_ID, detail(runtime)]]);
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, {
      version: 1,
      jobId: DURABLE_JOB_ID,
      pid: process.pid,
      processStartedAtSeconds: ownStartedAt + 3_600,
    });
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 7);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'absent', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });
});
