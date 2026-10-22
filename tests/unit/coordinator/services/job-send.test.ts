import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobSendService, type JobSendRequest, type JobSendServiceDeps } from '#src/coordinator/services/job-send.js';
import { formatJobSendResult } from '#src/cli/format/jobs.js';
import {
  holdProviderProxyOperationControl,
  createProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { findCommittedExecutionRequest } from '#src/jobs/execution-journal.js';
import { loadJobProjectionDetail } from '#src/jobs/read-queries.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { UNSUPPORTED_JOB_SEND_BUILD_REASON, type JobSendResult } from '#src/jobs/send.js';
import type { JobSendTarget } from '#src/jobs/send-target.js';
import type { JobStatus } from '#src/jobs/records.js';
import type { JobLocation } from '#src/jobs/location-index.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import {
  ControlClientError,
  controlExchangeForTest,
  type ControlClient,
  type ControlClientRemoteFailure,
} from '#src/provider-proxy/control-client.js';
import type { ProxyOperationSendResult } from '#src/provider-proxy/protocol.js';
import { totalChanges } from '#tests/helpers/test-db.js';
import {
  insertProviderOperation,
  deleteProviderOperation,
  readProviderOperationForJob,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import {
  executionHarness,
  EXECUTION_JOB_ID,
  openedJob,
  requestedExecution,
  executionInput,
} from '#tests/helpers/job-executions.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const root = fixtureCanonicalWorkDir('/workspace');
const ctx: InvocationContext = {
  projectRoot: root,
  pluginRoot: '/plugin',
  coralEnv: {},
  principal: testProjectPrincipal(root),
};
const messageId = '33333333-3333-4333-8333-333333333333';
const databases: ReturnType<typeof executionHarness>['db'][] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function harness({
  ended = false,
  record = providerOperationRecord('executing', {
    operation: {
      ...providerOperationRecord('executing').operation,
      jobId: EXECUTION_JOB_ID,
    },
  }),
}: { ended?: boolean; record?: ProviderOperationRecord | null } = {}) {
  const journal = executionHarness();
  databases.push(journal.db);
  journal.append(
    openedJob(),
    requestedExecution(1),
    executionInput('job.execution.admitted', { execution: 1, queuePosition: 0 }),
  );
  if (ended) journal.complete(1);
  if (record !== null) insertProviderOperation(journal.db, record);
  const readStatus = vi.fn(
    (): JobStatus | null => loadJobProjectionDetail(journal.db, EXECUTION_JOB_ID, journal.readCtx).status,
  );
  const sendOperation = vi
    .fn<NonNullable<ReturnType<JobSendServiceDeps['authorityFor']>>['sendOperation']>()
    .mockResolvedValue({ state: 'delivered', providerTurnId: 'turn-1' });
  const authorityFor = vi.fn<JobSendServiceDeps['authorityFor']>(() => ({ sendOperation }));
  const restore = vi.fn();
  const activate = vi.fn();
  const resume = vi.fn<JobSendServiceDeps['resume']>(async (request) => {
    const execution = request.target.execution + 1;
    const events = journal.append(
      requestedExecution(execution, { input: request.input, originatingClientMessageId: request.clientMessageId }),
      executionInput('job.execution.queued', { execution, queuePosition: 1, runningJobIds: [] }),
    );
    restore();
    activate();
    return {
      kind: 'provider-session',
      status: 'queued',
      jobId: request.jobId,
      requestedSeq: events[0].seq,
      epochKey: 'epoch',
    };
  });
  const deps: JobSendServiceDeps = {
    attempts: new Map(),
    progressStore: { getDb: () => journal.db, readStatus },
    jobLocations: { read: vi.fn(() => null) },
    currentJobEpochKey: () => 'epoch',
    resume,
    authorityFor,
  };
  const service = () => new JobSendService(deps);
  const target = (mode: JobSendTarget['mode'], execution = 1): JobSendTarget => {
    const row = journal.db
      .prepare<
        [number],
        { seq: number }
      >("SELECT seq FROM events WHERE type = 'job.execution.requested' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
      .get(execution)!;
    return { mode, execution, requestedSeq: row.seq, sourceEpoch: 'epoch' };
  };
  const request = (mode: JobSendTarget['mode'] = ended ? 'continue' : 'steer'): JobSendRequest => ({
    projectRoot: root,
    jobId: EXECUTION_JOB_ID,
    input: 'next input',
    clientMessageId: messageId,
    target: target(mode),
  });
  return {
    ...journal,
    deps,
    service,
    request,
    target,
    readStatus,
    sendOperation,
    authorityFor,
    resume,
    restore,
    activate,
    record,
  };
}

describe('JobSendService bound admission', () => {
  it.each(['', '   ', 'x'.repeat(65_537)])('refuses invalid input before reading or delivering', async (input) => {
    const h = harness();
    expect(await h.service().send({ ...h.request(), input }, ctx)).toMatchObject({
      state: 'refused',
      code: 'invalid_request',
      invalidFields: ['input'],
    });
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it.each([
    ['missing job', null, 'not_found'],
    ['another project', { workDir: fixtureCanonicalWorkDir('/other') }, 'scope_mismatch'],
    ['non-provider job', { jobKind: 'kb' }, 'transport_unsupported'],
  ] as const)('refuses %s before replay or effects', async (_label, patch, code) => {
    const h = harness({ ended: true, record: null });
    const status = h.readStatus();
    h.readStatus.mockReturnValue(patch === null ? null : { ...status!, ...patch });
    expect(
      await h.service().send(h.request(patch !== null && 'jobKind' in patch ? 'steer' : 'continue'), ctx),
    ).toMatchObject({
      state: 'refused',
      code,
    });
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { mode: 'steer' },
    { mode: 'continue', execution: 0, requestedSeq: 2, sourceEpoch: 'epoch' },
  ])('requires a complete target before effects: %j', async (target) => {
    const h = harness();
    expect(await h.service().send({ ...h.request(), target } as JobSendRequest, ctx)).toMatchObject({
      state: 'refused',
      code: 'invalid_request',
      invalidFields: ['target'],
    });
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('steers only the original operation with its unchanged message identity', async () => {
    const h = harness();
    const request = h.request();
    expect(await h.service().send(request, ctx)).toEqual({ state: 'delivered', providerTurnId: 'turn-1' });
    expect(h.sendOperation).toHaveBeenCalledExactlyOnceWith(h.record!.operation, {
      text: request.input,
      clientMessageId: request.clientMessageId,
    });
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('refuses finishing without asserting non-delivery of an earlier invocation', async () => {
    const h = harness();
    h.commit((c) => {
      appendJobExecutionOutcomeAccepted(c, {
        jobId: EXECUTION_JOB_ID,
        execution: 1,
        terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
      });
      return undefined;
    });
    const outcome = await h.service().send(h.request(), ctx);
    expect(outcome).toMatchObject({ state: 'refused', code: 'execution_finishing' });
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
    if (outcome.state !== 'refused') throw new Error('expected refusal');
    const rendered = formatJobSendResult(EXECUTION_JOB_ID, outcome);
    expect(rendered.text).toContain(`jobs wait ${EXECUTION_JOB_ID}`);
    expect(rendered.text).toContain('may have delivered');
    expect(rendered.text).toContain('new message ID');
  });

  it.each([
    'prepare-pending',
    'guardian-activation-pending',
    'proxy-activation-pending',
    'local-recovery-pending',
    'activation-resolution-pending',
    'prestart-cleanup-pending',
  ] as const)('refuses %s before authority contact', async (phase) => {
    const h = harness({
      record: providerOperationRecord(phase, {
        operation: { ...providerOperationRecord(phase).operation, jobId: EXECUTION_JOB_ID },
      }),
    });
    expect(await h.service().send(h.request(), ctx)).toMatchObject({ state: 'refused', code: 'turn_not_started' });
    expect(h.authorityFor).not.toHaveBeenCalled();
  });

  it('refuses a missing operation or authority', async () => {
    const h = harness({ record: null });
    expect(await h.service().send(h.request(), ctx)).toMatchObject({ code: 'turn_not_started' });
    const live = harness();
    live.authorityFor.mockReturnValue(null);
    expect(await live.service().send(live.request(), ctx)).toMatchObject({ code: 'control_unavailable' });
    expect(live.sendOperation).not.toHaveBeenCalled();
  });

  it('refuses stop intent before contacting authority', async () => {
    const base = providerOperationRecord('executing', {
      operation: { ...providerOperationRecord('executing').operation, jobId: EXECUTION_JOB_ID },
    });
    const h = harness({
      record: providerOperationRecordSchema.parse({
        ...base,
        operation: { ...base.operation, jobId: EXECUTION_JOB_ID },
        controlIntent: { kind: 'stop', cause: 'user_abort', requestedAt: '2026-10-22T00:00:00.000Z' },
      }),
    });
    expect(await h.service().send(h.request(), ctx)).toMatchObject({ code: 'job_not_running' });
    expect(h.authorityFor).not.toHaveBeenCalled();
  });

  it.each(['operation-control-outcome-unknown', 'operator-exit-fenced'] as const)(
    'translates a real %s authority hold without provider contact',
    async (reason) => {
      const h = harness();
      const exchange = vi.fn<ControlClient['exchange']>();
      const client = { exchange } as unknown as ControlClient;
      const authority = createProviderProxyOperationAuthority({
        base: {} as never,
        setIdentity: providerProxySetIdentityFromRecord(h.record!),
        clients: { proxy: client, guardian: client, reaper: client },
        faults: createProviderProxyAuthorityFaultLatch(),
        mutationRpcTimeoutMs: 1_000,
      });
      holdProviderProxyOperationControl(authority, reason);
      h.authorityFor.mockReturnValue(authority);
      expect(await h.service().send(h.request(), ctx)).toMatchObject({ code: 'control_unavailable' });
      expect(exchange).not.toHaveBeenCalled();
    },
  );

  it.each<JobSendResult>([
    { state: 'unknown', reason: 'reply lost' },
    { state: 'refused', code: 'provider_rejected', reason: 'declined' },
  ])('preserves the operation result %j without journal writes', async (outcome) => {
    const h = harness();
    const before = h.events();
    h.sendOperation.mockResolvedValue(outcome as never);
    expect(await h.service().send(h.request(), ctx)).toEqual(outcome);
    expect(h.events()).toEqual(before);
    expect(h.resume).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running', 'finishing', 'ended', 'successor'] as const)(
    'replays lost #2 launch while %s, including a new coordinator service',
    async (state) => {
      const h = harness({ ended: true, record: null });
      const request = h.request();
      const original = await h.service().send(request, ctx);
      if (state !== 'queued') {
        h.append(
          executionInput('job.execution.admitted', { execution: 2, queuePosition: 0 }),
          executionInput('job.execution.started', {
            execution: 2,
            transport: 'app-server',
            startedAt: '2026-10-22T00:00:00.000Z',
            providerMeta: { provider: 'codex', leaseState: 'waiting' },
          }),
        );
      }
      if (state === 'finishing')
        h.commit((c) => {
          appendJobExecutionOutcomeAccepted(c, {
            jobId: EXECUTION_JOB_ID,
            execution: 2,
            terminal: { content: 'second', durationMs: 1, outcome: { kind: 'completed' } },
          });
          return undefined;
        });
      if (state === 'ended' || state === 'successor') h.complete(2);
      if (state === 'successor')
        h.append(requestedExecution(3), executionInput('job.execution.admitted', { execution: 3, queuePosition: 0 }));
      const before = h.events();
      for (let retry = 0; retry < 2; retry++) expect(await h.service().send(request, ctx)).toEqual(original);
      expect(h.resume).toHaveBeenCalledTimes(1);
      expect(h.restore).toHaveBeenCalledTimes(1);
      expect(h.activate).toHaveBeenCalledTimes(1);
      expect(h.sendOperation).not.toHaveBeenCalled();
      expect(h.events()).toEqual(before);
      expect(findCommittedExecutionRequest(h.db, EXECUTION_JOB_ID, messageId)?.request.input).toBe(request.input);
    },
  );

  it.each([true, false])(
    'serializes a pending continuation before persistence, identical message=%s',
    async (identical) => {
      const h = harness({ ended: true, record: null });
      const resume = h.resume.getMockImplementation()!;
      let admit!: () => void;
      const pendingAdmission = new Promise<void>((resolve) => {
        admit = resolve;
      });
      h.resume.mockImplementation(async (...args) => {
        await pendingAdmission;
        return resume(...args);
      });
      const request = h.request();
      const first = h.service().send(request, ctx);
      await Promise.resolve();
      await Promise.resolve();
      expect(h.resume).toHaveBeenCalledTimes(1);
      const second = h
        .service()
        .send(
          { ...request, clientMessageId: identical ? request.clientMessageId : '44444444-4444-4444-8444-444444444444' },
          ctx,
        );
      await Promise.resolve();
      await Promise.resolve();
      expect(h.resume).toHaveBeenCalledTimes(1);
      admit();
      const winner = await first;
      expect(winner.state).toBe('launched');
      if (identical) expect(await second).toEqual(winner);
      else expect(await second).toMatchObject({ state: 'refused', code: 'continuation_target_changed' });
      expect(h.resume).toHaveBeenCalledTimes(1);
      expect(h.sendOperation).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'closes a lost steer after end, successor=%s, across coordinator reconstruction',
    async (successor) => {
      const h = harness();
      const request = h.request();
      await h.service().send(request, ctx);
      deleteProviderOperation(h.db, h.record!);
      h.complete();
      if (successor)
        h.append(requestedExecution(2), executionInput('job.execution.admitted', { execution: 2, queuePosition: 0 }));
      const before = h.events();
      const outcome = await h.service().send(request, ctx);
      expect(outcome).toMatchObject({ state: 'unknown', reason: expect.stringContaining('may have been delivered') });
      expect(h.sendOperation).toHaveBeenCalledTimes(1);
      expect(h.resume).not.toHaveBeenCalled();
      expect(h.restore).not.toHaveBeenCalled();
      expect(h.activate).not.toHaveBeenCalled();
      expect(h.events()).toEqual(before);
    },
  );

  it.each([{ requestedSeq: 999 }, { sourceEpoch: 'other' }, { execution: 2 }])(
    'refuses a changed continuation boundary %j',
    async (patch) => {
      const h = harness({ ended: true, record: null });
      const request = h.request();
      expect(await h.service().send({ ...request, target: { ...request.target, ...patch } }, ctx)).toMatchObject({
        code: 'continuation_target_changed',
      });
      expect(h.resume).not.toHaveBeenCalled();
    },
  );

  it.each(['workflow', 'discussion', 'system-task'] as const)(
    'does not continue a %s-owned provider job',
    async (kind) => {
      const h = harness({ ended: true, record: null });
      h.readStatus.mockReturnValue({ ...h.readStatus()!, owner: { kind, id: 'owner' } });
      expect(await h.service().send(h.request(), ctx)).toMatchObject({ code: 'owner_not_provider_session' });
      expect(h.resume).not.toHaveBeenCalled();
      expect(h.sendOperation).not.toHaveBeenCalled();
    },
  );

  it.each(['input', 'execution', 'requestedSeq', 'sourceEpoch', 'mode'] as const)(
    'refuses an altered %s that reuses a committed message ID',
    async (field) => {
      const h = harness({ ended: true, record: null });
      const request = h.request();
      await h.service().send(request, ctx);
      const altered = { ...request, target: { ...request.target } };
      switch (field) {
        case 'input':
          altered.input = 'different';
          break;
        case 'execution':
          altered.target.execution = 99;
          break;
        case 'requestedSeq':
          altered.target.requestedSeq = 99;
          break;
        case 'sourceEpoch':
          altered.target.sourceEpoch = 'other-epoch';
          break;
        case 'mode':
          altered.target.mode = 'steer';
          break;
      }
      expect(await h.service().send(altered, ctx)).toMatchObject({
        code: 'continuation_target_changed',
      });
      expect(h.resume).toHaveBeenCalledTimes(1);
      expect(h.sendOperation).not.toHaveBeenCalled();
    },
  );

  it('renders a changed predecessor with job detail and a new send attempt', async () => {
    const h = harness({ ended: true, record: null });
    const request = h.request();
    await h.service().send(request, ctx);
    const result = await h.service().send({ ...request, clientMessageId: '55555555-5555-4555-8555-555555555555' }, ctx);
    if (result.state !== 'refused') throw new Error('expected refusal');
    const rendered = formatJobSendResult(EXECUTION_JOB_ID, result, { inputTokens: ['next input'] });
    expect(rendered.exitCode).toBe(1);
    expect(rendered.text).toContain(`jobs detail ${EXECUTION_JOB_ID}`);
    expect(rendered.text).toContain(`jobs send ${EXECUTION_JOB_ID}`);
    expect(rendered.text).toContain('new message ID');
  });
});

describe('jobs send typed continuation refusals', () => {
  it.each(['steer', 'continue'] as const)(
    'refuses a direct %s RPC for another project before classifying its historical location',
    async (mode) => {
      const h = harness({ ended: true, record: null });
      const request = h.request(mode);
      h.readStatus.mockReturnValue(null);
      const otherRoot = fixtureCanonicalWorkDir('/other');
      const read = vi.fn(
        (): JobLocation => ({
          version: 'v1',
          jobId: EXECUTION_JOB_ID,
          epochKey: 'historical-epoch',
          subject: { projectRoot: otherRoot, workDir: otherRoot, jobKind: 'provider' },
          disposition: 'terminal',
          detail: { kind: 'unreadable' },
        }),
      );
      h.deps.jobLocations = { read };

      expect(await h.service().send(request, ctx)).toMatchObject({ state: 'refused', code: 'scope_mismatch' });
      expect(read).toHaveBeenCalledExactlyOnceWith(EXECUTION_JOB_ID);
      expect(h.resume).not.toHaveBeenCalled();
      expect(h.sendOperation).not.toHaveBeenCalled();
    },
  );

  it('distinguishes a pre-generation location from a job never recorded', async () => {
    const h = harness({ ended: true, record: null });
    const request = h.request();
    h.readStatus.mockReturnValue(null);
    const read = vi.fn((): JobLocation | null => ({
      version: 'v1',
      jobId: EXECUTION_JOB_ID,
      epochKey: 'historical-epoch',
      subject: { projectRoot: root, workDir: root, jobKind: 'provider' },
      disposition: 'terminal',
      detail: { kind: 'unreadable' },
    }));
    h.deps.jobLocations = { read };
    expect(await h.service().send(request, ctx)).toMatchObject({ state: 'refused', code: 'pre_generation_job' });
    expect(read).toHaveBeenCalledExactlyOnceWith(EXECUTION_JOB_ID);
    read.mockReturnValue(null);
    expect(await h.service().send(request, ctx)).toMatchObject({ state: 'refused', code: 'not_found' });
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.sendOperation).not.toHaveBeenCalled();
  });

  it('gives a non-provider continuation its own refusal without changing steering codes', async () => {
    const h = harness({ ended: true, record: null });
    h.readStatus.mockReturnValue({ ...h.readStatus()!, jobKind: 'kb' });
    expect(await h.service().send(h.request(), ctx)).toMatchObject({ state: 'refused', code: 'non_provider_job' });
    expect(h.resume).not.toHaveBeenCalled();
  });

  it.each([
    ['archive_missing', 'archive_missing'],
    ['non_resumable', 'archive_missing'],
    ['archive_stale', 'archive_missing'],
    ['archive_hash_mismatch', 'archive_hash_mismatch'],
    ['profile_mismatch', 'profile_mismatch'],
    ['provider_binding_profile_mismatch', 'profile_mismatch'],
    ['provider_binding_subject_mismatch', 'profile_mismatch'],
    ['work_directory_missing', 'work_directory_missing'],
    ['session_busy', 'session_busy'],
    ['busy', 'busy'],
    ['succession_admission_paused', 'succession_admission_paused'],
    ['retention_discard_in_flight', 'execution_finishing'],
    ['execution_admission_in_flight', 'execution_finishing'],
    ['native_unobservable', 'native_unobservable'],
    ['archive_invalid', 'archive_invalid'],
    ['provider_preflight_failed', 'provider_preflight_failed'],
    ['session_not_found', 'session_not_found'],
    ['execution_superseded', 'execution_superseded'],
    ['transport_unsupported', 'transport_unsupported'],
    ['provider_execution_environment_invalid', 'provider_rejected'],
  ] as const)('preserves the continuation refusal %s as %s', async (launchCode, code) => {
    const h = harness({ ended: true, record: null });
    const before = h.events();
    h.resume.mockResolvedValue({ status: 'refused', code: launchCode, message: 'Decisive admission refusal.' });
    const result = await h.service().send(h.request(), ctx);
    expect(result).toEqual({ state: 'refused', code, reason: 'Decisive admission refusal.' });
    if (code === 'profile_mismatch')
      expect(formatJobSendResult(EXECUTION_JOB_ID, result).text).toContain(
        'Continuation is impossible from this environment',
      );
    else
      expect(formatJobSendResult(EXECUTION_JOB_ID, result, { inputTokens: ['next input'] }).text).toMatch(
        /^command=coral-cli /m,
      );
    expect(h.events()).toEqual(before);
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
  });
});

it.each([
  { status: 'refused', code: 'execution_finishing', message: 'Previous cleanup is pending.' },
  { status: 'refused', code: 'archive_missing', message: 'The archive is missing.' },
  { status: 'undetermined', code: 'provider_preflight_undetermined', message: 'Provider readiness is unknown.' },
  { status: 'undetermined', code: 'work_directory_unobservable', message: 'Work directory cannot be observed.' },
] as const)('consumes the continuation decision %j', async (decision) => {
  const h = harness({ ended: true, record: null });
  h.resume.mockResolvedValueOnce(decision);
  const result = await h.service().send(h.request(), ctx);
  expect(result).toMatchObject({ state: 'refused', code: decision.code });
  expect(h.restore).not.toHaveBeenCalled();
  expect(h.activate).not.toHaveBeenCalled();
});

it('refuses a missing steer job before provider contact', async () => {
  const h = harness();
  h.readStatus.mockReturnValue(null);
  expect(await h.service().send(h.request(), ctx)).toMatchObject({ state: 'refused', code: 'not_found' });
  expect(h.sendOperation).not.toHaveBeenCalled();
  expect(h.resume).not.toHaveBeenCalled();
});

it('cannot authorize delivery while committed-request replay evidence is unavailable', async () => {
  const h = harness({ ended: true, record: null });
  const request = h.request();
  const original = await h.service().send(request, ctx);
  const prepare = h.db.prepare.bind(h.db);
  const failedRead = vi.spyOn(h.db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes("type = 'job.execution.requested' ORDER BY seq")) throw new Error('request evidence unavailable');
    return prepare(sql);
  }) as typeof h.db.prepare);
  await expect(h.service().send(request, ctx)).rejects.toThrow('request evidence unavailable');
  failedRead.mockRestore();
  expect(await h.service().send(request, ctx)).toEqual(original);
  expect(h.resume).toHaveBeenCalledTimes(1);
  expect(h.restore).toHaveBeenCalledTimes(1);
  expect(h.activate).toHaveBeenCalledTimes(1);
  expect(h.sendOperation).not.toHaveBeenCalled();
});

function liveAuthority(record: ProviderOperationRecord, exchange: ControlClient['exchange']) {
  const client = { exchange } as unknown as ControlClient;
  return createProviderProxyOperationAuthority({
    base: {} as never,
    setIdentity: providerProxySetIdentityFromRecord(record),
    clients: { proxy: client, guardian: client, reaper: client },
    faults: createProviderProxyAuthorityFaultLatch(),
    mutationRpcTimeoutMs: 1_000,
  });
}

describe('JobSendService operation guards', () => {
  it.each(['prestart-cleanup-pending', 'activation-resolution-pending'] as const)(
    'recognizes a prestart cancellation in %s before the startup gate',
    async (phase) => {
      const aborted = { kind: 'terminal-aborted', cause: 'user_abort', requestedAt: '2026-10-17T12:00:00.000Z' };
      const record = providerOperationRecordSchema.parse({
        ...providerOperationRecord(phase, {
          operation: { ...providerOperationRecord(phase).operation, jobId: EXECUTION_JOB_ID },
        }),
        ...(phase === 'prestart-cleanup-pending' ? { afterRelease: aborted } : { onNeverStarted: aborted }),
      });
      const h = harness({
        record: providerOperationRecordSchema.parse({
          ...record,
          operation: { ...record.operation, jobId: EXECUTION_JOB_ID },
        }),
      });
      const before = totalChanges(h.db);

      await expect(h.service().send(h.request(), ctx)).resolves.toMatchObject({
        state: 'refused',
        code: 'job_not_running',
      });

      expect(h.authorityFor).not.toHaveBeenCalled();
      expect(h.sendOperation).not.toHaveBeenCalled();
      expect(totalChanges(h.db)).toBe(before);
    },
  );

  it.each(['method_not_found', null] as const)(
    'reports an older proxy as refused/1 without a retry remedy or durable mutation: %s',
    async (protocolCode) => {
      const h = harness();
      const failure: ControlClientRemoteFailure = {
        kind: 'json-rpc-error',
        jsonRpcCode: -32601,
        protocolCode,
        admissionReason: null,
        heartbeatRefusal: null,
      };
      const exchange = vi.fn(async () =>
        controlExchangeForTest({
          kind: 'response',
          response: {
            kind: 'refusal',
            failure,
            error: new ControlClientError('control_call_failed', 'Unknown method', 'remote-response', failure),
          },
        }),
      );
      h.authorityFor.mockReturnValue(liveAuthority(h.record!, exchange));
      const before = totalChanges(h.db);

      const outcome = await h.service().send(h.request(), ctx);
      expect(outcome).toEqual({
        state: 'refused',
        code: 'unsupported_by_running_build',
        reason: UNSUPPORTED_JOB_SEND_BUILD_REASON,
      });

      const output = formatJobSendResult(EXECUTION_JOB_ID, outcome);
      expect(output.exitCode).toBe(1);
      expect(output.text).toContain('unsupported_by_running_build');
      expect(output.text).toContain(UNSUPPORTED_JOB_SEND_BUILD_REASON);
      expect(output.text).not.toMatch(/restart|shutdown|backend start|command=coral-cli jobs send/iu);
      expect(output.text).toContain('Retry the send after the installed build is serving');
      expect(output.text).toContain('command=coral-cli backend status');
      expect(output.text).not.toMatch(/may have been delivered/i);
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(totalChanges(h.db)).toBe(before);
      expect(readProviderOperationForJob(h.db, EXECUTION_JOB_ID)).toEqual(h.record);
    },
  );

  it('writes no durable intent or progress while the provider answer is pending', async () => {
    const h = harness();
    let answer!: (outcome: ProxyOperationSendResult) => void;
    h.sendOperation.mockReturnValue(
      new Promise<ProxyOperationSendResult>((resolve) => {
        answer = resolve;
      }),
    );
    const before = totalChanges(h.db);

    const pending = h.service().send(h.request(), ctx);
    await Promise.resolve();

    expect(h.sendOperation).toHaveBeenCalledTimes(1);
    expect(totalChanges(h.db)).toBe(before);
    expect(readProviderOperationForJob(h.db, EXECUTION_JOB_ID)).toEqual(h.record);
    answer({ state: 'delivered', providerTurnId: 'turn-1' });
    await expect(pending).resolves.toEqual({ state: 'delivered', providerTurnId: 'turn-1' });
    expect(totalChanges(h.db)).toBe(before);
  });
  it('uses the canonical caller root and permits a descendant work directory', async () => {
    const h = harness();
    h.readStatus.mockReturnValue({
      ...h.readStatus()!,
      projectRoot: '/unrelated-launch-root',
      workDir: fixtureCanonicalWorkDir('/workspace/child'),
    });
    expect(await h.service().send(h.request(), ctx)).toMatchObject({ state: 'delivered' });
    expect(
      await h.service().send({ ...h.request(), projectRoot: fixtureCanonicalWorkDir('/unrelated-launch-root') }, ctx),
    ).toMatchObject({ state: 'refused', code: 'scope_mismatch' });
    expect(h.sendOperation).toHaveBeenCalledTimes(1);
  });
});

it.each(['steer', 'continue'] as const)('accepts equivalent epoch encodings for %s and its replay', async (mode) => {
  const h = harness({ ended: mode === 'continue', record: mode === 'continue' ? null : undefined });
  const request = h.request(mode);
  const envelope = {
    ...request,
    target: { ...request.target, sourceEpoch: JSON.stringify({ epoch: 'epoch-1', lineageKey: 'epoch' }) },
  };
  const result = await h.service().send(envelope, ctx);
  expect(result.state).toBe(mode === 'continue' ? 'launched' : 'delivered');
  expect(await h.service().send(envelope, ctx)).toEqual(result);
  expect(h.resume).toHaveBeenCalledTimes(mode === 'continue' ? 1 : 0);
});

it.each([{ execution: 99 }, { requestedSeq: 99 }, { sourceEpoch: 'retired-epoch' }])(
  'refuses a stale steer address without provider contact: %j',
  async (target) => {
    const h = harness();
    const request = h.request();
    expect(await h.service().send({ ...request, target: { ...request.target, ...target } }, ctx)).toMatchObject({
      state: 'refused',
      code: 'execution_superseded',
    });
    expect(h.authorityFor).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  },
);
