import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { writeDurableCliProcessRuntimeMeta } from '#src/jobs/runtime-meta-store.js';
import type * as NodeProcess from '#src/infra/node-process.js';

// `observeProcessLiveness`/`probeProcessIncarnation` default to the real implementation so every existing test
// below keeps observing genuine OS state; only the ambiguous-evidence test overrides them (once each) to
// stage the alive-but-unreadable-start-time combination without depending on real `/proc` timing.
vi.mock('#src/infra/node-process.js', async (importOriginal) => {
  const original = await importOriginal<typeof NodeProcess>();
  return {
    ...original,
    observeProcessLiveness: vi.fn(original.observeProcessLiveness),
    probeProcessIncarnation: vi.fn(original.probeProcessIncarnation),
  };
});

import { observeProcessLiveness, probeProcessIncarnation } from '#src/infra/node-process.js';
import {
  admittedByThisCoordinator,
  classifyLocalCarriers,
  collectLocalCarrierInputs,
  createObserveCarriers,
  type LocalCarrierRegistries,
  withExternalStatus,
} from '#src/coordinator/composition/carrier-observation.js';
import { carrierStatusOperationKey } from '#src/coordinator/live/carrier-observer.js';
import { classifyCarrier } from '#src/jobs/carrier-observation.js';
import type { JobProjectionDetail } from '#src/jobs/read-queries.js';
import type { JobRuntime, JobStatus } from '#src/jobs/records.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const mockedIsAlive = vi.mocked(observeProcessLiveness);
const mockedProbe = vi.mocked(probeProcessIncarnation);

const PLATFORM = process.platform;
// Guaranteed to name no process this OS ever assigns, so both the OS start-time probe and the alive check
// answer "nothing there" without depending on what else happens to be running.
const DEAD_PID = 2_147_483_647;
// `durable_cli_process.v1` keys on a canonical UUID.
const DURABLE_JOB_ID = '00000000-0000-4000-8000-000000000099';
const ACQUIRED_JOB_ID = '00000000-0000-4000-8000-000000000098';

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

function acquiredRuntime(): JobRuntime {
  return {
    transport: 'app-server',
    startTime: '2026-04-19T00:00:00.000Z',
    providerMeta: {
      provider: 'codex',
      leaseState: 'acquired',
      hostRef: { provider: 'codex', fingerprint: 'f', instanceId: 'i', leaseMode: 'shared' },
    },
  };
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
    hasStartupRecoveryPassed: () => false,
    isAdmittedByThisCoordinator: () => false,
    registryStateForJob: () => null,
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

  it('reports app-server-acquired as unknown before startup recovery passes', async () => {
    const details = new Map([['job-1', detail(acquiredRuntime())]]);
    const db = createDb();
    const observe = createObserveCarriers(
      registriesFor(details, { getDb: () => db, isAdmittedByThisCoordinator: () => true }),
      () => 7,
    );

    expect(await observe(['job-1'])).toEqual([
      { jobId: 'job-1', liveness: 'unknown', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });

  it('keeps a missing local registry entry defect-free when a durable operation still owns the job', () => {
    const db = createDb();
    const record = providerOperationRecord('executing', { job: 98 });
    insertProviderOperation(db, record);
    const details = new Map([[ACQUIRED_JOB_ID, detail(acquiredRuntime(), { jobId: ACQUIRED_JOB_ID })]]);

    const [result] = classifyLocalCarriers(
      [ACQUIRED_JOB_ID],
      registriesFor(details, {
        getDb: () => db,
        hasStartupRecoveryPassed: () => true,
      }),
      7,
    );

    expect(result?.observation.liveness).toBe('unknown');
    expect(result?.observation.defect).toBeUndefined();
  });

  it('reports an advisory defect when settlement removes both owners before the terminal projects', () => {
    const db = createDb();
    const details = new Map([[ACQUIRED_JOB_ID, detail(acquiredRuntime(), { jobId: ACQUIRED_JOB_ID })]]);

    const [result] = classifyLocalCarriers(
      [ACQUIRED_JOB_ID],
      registriesFor(details, {
        getDb: () => db,
        hasStartupRecoveryPassed: () => true,
      }),
      7,
    );

    expect(result?.observation.liveness).toBe('unknown');
    expect(result?.observation.defect).toBe('local-unknown-after-recovery-decision');
  });

  it.each([
    ['held', 'live'],
    ['absent', 'absent'],
    ['unknown', 'unknown'],
  ] as const)('merges inherited proxy status %s as %s through the pure classifier', (externalStatus, liveness) => {
    const db = createDb();
    const record = providerOperationRecord('executing', { job: 98 });
    insertProviderOperation(db, record);
    const details = new Map([[ACQUIRED_JOB_ID, detail(acquiredRuntime(), { jobId: ACQUIRED_JOB_ID })]]);
    const [collected] = collectLocalCarrierInputs([ACQUIRED_JOB_ID], registriesFor(details, { getDb: () => db }), 7);
    if (collected === undefined) throw new Error('expected a collected carrier input');

    const observation = classifyCarrier(withExternalStatus(collected.input, externalStatus));

    expect(observation).toMatchObject({ liveness, source: 'proxy-operation-status' });
  });

  it('batches the exact durable operation and proxy locator instead of deriving either from HostRef', async () => {
    const db = createDb();
    const record = providerOperationRecord('executing', { job: 98 });
    insertProviderOperation(db, record);
    const details = new Map([[ACQUIRED_JOB_ID, detail(acquiredRuntime(), { jobId: ACQUIRED_JOB_ID })]]);
    const observeExternal = vi.fn(
      async () => new Map([[carrierStatusOperationKey(record.operation), 'absent' as const]]),
    );
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 7, observeExternal);

    await expect(observe([ACQUIRED_JOB_ID])).resolves.toEqual([
      { jobId: ACQUIRED_JOB_ID, liveness: 'absent', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
    expect(observeExternal).toHaveBeenCalledWith([record]);
  });

  it('treats a missing durable record and a missing observer map entry as unknown', async () => {
    const missingRecordDb = createDb();
    const recordDb = createDb();
    const record = providerOperationRecord('executing', { job: 98 });
    insertProviderOperation(recordDb, record);
    const details = new Map([[ACQUIRED_JOB_ID, detail(acquiredRuntime(), { jobId: ACQUIRED_JOB_ID })]]);
    const observeExternal = vi.fn(async () => new Map());
    const withoutRecord = createObserveCarriers(
      registriesFor(details, { getDb: () => missingRecordDb }),
      () => 7,
      observeExternal,
    );
    const withoutMapEntry = createObserveCarriers(
      registriesFor(details, { getDb: () => recordDb }),
      () => 7,
      observeExternal,
    );

    await expect(withoutRecord([ACQUIRED_JOB_ID])).resolves.toMatchObject([{ liveness: 'unknown' }]);
    expect(observeExternal).not.toHaveBeenCalled();
    await expect(withoutMapEntry([ACQUIRED_JOB_ID])).resolves.toMatchObject([{ liveness: 'unknown' }]);
    expect(observeExternal).toHaveBeenCalledOnce();
  });

  it.each(['activated', 'attached'] as const)(
    'lets local %s evidence win without invoking the observer',
    async (state) => {
      const details = new Map([[ACQUIRED_JOB_ID, detail(acquiredRuntime(), { jobId: ACQUIRED_JOB_ID })]]);
      const observeExternal = vi.fn(async () => new Map());
      const observe = createObserveCarriers(
        registriesFor(details, { registryStateForJob: () => state }),
        () => 7,
        observeExternal,
      );

      await expect(observe([ACQUIRED_JOB_ID])).resolves.toMatchObject([{ liveness: 'live' }]);
      expect(observeExternal).not.toHaveBeenCalled();
    },
  );

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
    writeDurableCliProcessRuntimeMeta(db, {
      version: 1,
      jobId: DURABLE_JOB_ID,
      pid: 222,
      incarnation: testIncarnation(1),
    });
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
      incarnation: testIncarnation(1),
    });
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 9);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'absent', storedPhase: 'running', observedMaxJournalSeq: 9 },
    ]);
  });

  it('reports a durable CLI job as live when the recorded pid and incarnation both still match', async () => {
    const ownIncarnation = probeProcessIncarnation(process.pid, PLATFORM);
    // Only the current test process's own pid is guaranteed alive and probeable from this test.
    if (ownIncarnation === null) return;
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
      incarnation: ownIncarnation,
    });
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 7);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'live', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });

  it('reports a durable CLI job as absent when the pid is alive but its incarnation no longer matches — a recycled pid', async () => {
    const ownIncarnation = probeProcessIncarnation(process.pid, PLATFORM);
    if (ownIncarnation === null) return;
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
      incarnation: testIncarnation('a-different-incarnation'),
    });
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 7);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'absent', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });

  it('reports a durable CLI job as unknown when the pid is alive but its incarnation is unreadable — the ambiguous case the tri-state exists for', async () => {
    // A recycled pid cannot be told apart from the same process without a start-time reading, so an alive
    // pid whose incarnation the OS probe could not produce must stay `unknown`, never fall through to the
    // `alive: false` shape that would report `absent` — that is exactly the guard this test pins.
    const runtime: JobRuntime = {
      transport: 'durable-cli',
      pid: 4242,
      stdoutPath: '/tmp/o',
      stderrPath: '/tmp/e',
      startTime: '2026-04-19T00:00:00.000Z',
    };
    const details = new Map([[DURABLE_JOB_ID, detail(runtime)]]);
    const db = createDb();
    writeDurableCliProcessRuntimeMeta(db, {
      version: 1,
      jobId: DURABLE_JOB_ID,
      pid: 4242,
      incarnation: testIncarnation(1),
    });
    mockedProbe.mockReturnValueOnce(null);
    mockedIsAlive.mockReturnValueOnce('alive');
    const observe = createObserveCarriers(registriesFor(details, { getDb: () => db }), () => 7);

    expect(await observe([DURABLE_JOB_ID])).toEqual([
      { jobId: DURABLE_JOB_ID, liveness: 'unknown', storedPhase: 'running', observedMaxJournalSeq: 7 },
    ]);
  });
});
