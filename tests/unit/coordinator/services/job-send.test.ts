import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatJobSendResult } from '#src/cli/format/jobs.js';
import {
  createProviderProxyOperationAuthority,
  holdProviderProxyOperationControl,
  type DurableProviderProxyOperationAuthority,
} from '#src/coordinator/live/provider-proxy/operation-route.js';
import { JobSendService, type JobSendServiceDeps } from '#src/coordinator/services/job-send.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import type { JobStatus } from '#src/jobs/records.js';
import {
  ControlClientError,
  controlExchangeForTest,
  type ControlClient,
  type ControlClientRemoteFailure,
} from '#src/provider-proxy/control-client.js';
import type { ProxyOperationSendResult } from '#src/provider-proxy/protocol.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { insertProviderOperation, readProviderOperationForJob } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema, type ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { newRawDatabase, totalChanges } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const PROJECT_ROOT = fixtureCanonicalWorkDir('/project');
const EXECUTING = providerOperationRecord('executing');
const REQUEST = {
  projectRoot: PROJECT_ROOT,
  jobId: EXECUTING.operation.jobId,
  input: 'Check the cancellation path too',
  clientMessageId: '33333333-3333-4333-8333-333333333333',
};
const DELIVERED = { state: 'delivered', providerTurnId: 'turn-1' } as const;
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function jobStatus(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    jobId: REQUEST.jobId,
    execution: 1,
    finishing: false,
    owner: { kind: 'provider-session', id: 'session-1' },
    sessionId: 'session-1',
    provider: 'codex',
    projectRoot: PROJECT_ROOT,
    workDir: PROJECT_ROOT,
    backendNamespace: 'tests',
    jobKind: 'provider',
    phase: 'running',
    updatedAt: '2026-10-17T12:00:00.000Z',
    ...overrides,
  };
}

function harness({
  status = jobStatus(),
  record = EXECUTING,
}: { status?: JobStatus | null; record?: ProviderOperationRecord | null } = {}) {
  const db = newRawDatabase(':memory:');
  databases.push(db);
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  if (record !== null) insertProviderOperation(db, record);
  const readStatus = vi.fn(() => status);
  const getDb = vi.fn(() => db);
  const sendOperation = vi.fn<DurableProviderProxyOperationAuthority['sendOperation']>().mockResolvedValue(DELIVERED);
  const authorityFor = vi.fn<JobSendServiceDeps['authorityFor']>(() => ({ sendOperation }));
  const service = new JobSendService({ progressStore: { readStatus, getDb }, authorityFor });
  return { service, db, readStatus, getDb, authorityFor, sendOperation };
}

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

describe('JobSendService', () => {
  it.each([
    { defect: 'unknown job', status: null, code: 'not_found' },
    {
      defect: 'cross-project job',
      status: jobStatus({ workDir: fixtureCanonicalWorkDir('/other-project'), phase: 'completed' }),
      code: 'scope_mismatch',
    },
    {
      defect: 'sibling directory sharing a prefix',
      status: jobStatus({ workDir: fixtureCanonicalWorkDir('/project-other') }),
      code: 'scope_mismatch',
    },
    {
      defect: 'workflow job even when terminal',
      status: jobStatus({
        jobKind: 'workflow',
        owner: { kind: 'workflow', id: REQUEST.jobId },
        sessionId: null,
        provider: null,
        phase: 'completed',
      }),
      code: 'transport_unsupported',
    },
    {
      defect: 'KB job without a work directory',
      status: jobStatus({
        jobKind: 'kb',
        owner: { kind: 'system-task', id: 'kb-source-import' },
        workDir: null,
        sessionId: null,
        provider: null,
      }),
      code: 'transport_unsupported',
    },
    {
      defect: 'internal one-shot curation owned by a KB system task',
      status: jobStatus({
        jobKind: 'kb',
        owner: { kind: 'system-task', id: 'kb-curate-assistant' },
        workDir: null,
        provider: 'claude',
        sessionId: null,
      }),
      code: 'transport_unsupported',
    },
    { defect: 'finishing execution', status: jobStatus({ finishing: true }), code: 'turn_ended' },
    ...(['completed', 'error', 'aborted'] as const).map((phase) => ({
      defect: `${phase} job despite an executing operation`,
      status: jobStatus({ phase }),
      code: 'turn_ended',
    })),
  ])('refuses $defect before operation lookup or authority contact', async ({ status, code }) => {
    const h = harness({ status });
    const before = totalChanges(h.db);

    await expect(h.service.send(REQUEST)).resolves.toMatchObject({ state: 'refused', code });

    expect(h.readStatus).toHaveBeenCalledWith(REQUEST.jobId);
    expect(h.getDb).not.toHaveBeenCalled();
    expect(h.authorityFor).not.toHaveBeenCalled();
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(totalChanges(h.db)).toBe(before);
  });

  it('uses the canonical caller root and permits a job in its descendant work directory', async () => {
    const h = harness({
      status: jobStatus({
        projectRoot: '/unrelated-launch-root',
        workDir: fixtureCanonicalWorkDir('/project/child'),
      }),
    });
    await expect(h.service.send(REQUEST)).resolves.toBe(DELIVERED);
    await expect(
      h.service.send({ ...REQUEST, projectRoot: fixtureCanonicalWorkDir('/unrelated-launch-root') }),
    ).resolves.toMatchObject({ state: 'refused', code: 'scope_mismatch' });
    expect(h.sendOperation).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'stop', cause: 'user_abort', requestedAt: '2026-10-17T12:00:00.000Z' },
    {
      kind: 'rekey-refusal-containment',
      cause: 'coordinator_rekey_refused',
      reason: 'Controller rekey refused',
      requestedAt: '2026-10-17T12:00:00.000Z',
    },
  ])('refuses the $kind intent before authority lookup', async (controlIntent) => {
    const record = providerOperationRecordSchema.parse({ ...EXECUTING, controlIntent });
    const h = harness({ record });
    const before = totalChanges(h.db);

    await expect(h.service.send(REQUEST)).resolves.toMatchObject({ state: 'refused', code: 'job_not_running' });

    expect(h.authorityFor).not.toHaveBeenCalled();
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(totalChanges(h.db)).toBe(before);
  });

  it('reports a terminal stopped job as turn_ended before examining its stop intent', async () => {
    const record = providerOperationRecordSchema.parse({
      ...EXECUTING,
      controlIntent: { kind: 'stop', cause: 'user_abort', requestedAt: '2026-10-17T12:00:00.000Z' },
    });
    const h = harness({ record, status: jobStatus({ phase: 'aborted' }) });
    await expect(h.service.send(REQUEST)).resolves.toMatchObject({ state: 'refused', code: 'turn_ended' });
    expect(h.getDb).not.toHaveBeenCalled();
    expect(h.authorityFor).not.toHaveBeenCalled();
    expect(h.sendOperation).not.toHaveBeenCalled();
  });

  it.each(['prestart-cleanup-pending', 'activation-resolution-pending'] as const)(
    'recognizes a prestart cancellation in %s before the startup gate',
    async (phase) => {
      const aborted = { kind: 'terminal-aborted', cause: 'user_abort', requestedAt: '2026-10-17T12:00:00.000Z' };
      const record = providerOperationRecordSchema.parse({
        ...providerOperationRecord(phase),
        ...(phase === 'prestart-cleanup-pending' ? { afterRelease: aborted } : { onNeverStarted: aborted }),
      });
      const h = harness({ record });
      const before = totalChanges(h.db);

      await expect(h.service.send(REQUEST)).resolves.toMatchObject({ state: 'refused', code: 'job_not_running' });

      expect(h.authorityFor).not.toHaveBeenCalled();
      expect(h.sendOperation).not.toHaveBeenCalled();
      expect(totalChanges(h.db)).toBe(before);
    },
  );

  it.each(['queued', 'launching', 'running'] as const)(
    'refuses a %s job with no provider operation before authority lookup',
    async (phase) => {
      const h = harness({ record: null, status: jobStatus({ phase }) });
      const before = totalChanges(h.db);
      await expect(h.service.send(REQUEST)).resolves.toMatchObject({ state: 'refused', code: 'turn_not_started' });
      expect(h.authorityFor).not.toHaveBeenCalled();
      expect(h.sendOperation).not.toHaveBeenCalled();
      expect(totalChanges(h.db)).toBe(before);
    },
  );

  it.each([
    'prepare-pending',
    'guardian-activation-pending',
    'proxy-activation-pending',
    'activation-resolution-pending',
    'prestart-cleanup-pending',
    'local-recovery-pending',
  ] as const)('requires an executing operation instead of %s before authority lookup', async (phase) => {
    const h = harness({ record: providerOperationRecord(phase) });
    const before = totalChanges(h.db);
    await expect(h.service.send(REQUEST)).resolves.toMatchObject({ state: 'refused', code: 'turn_not_started' });
    expect(h.authorityFor).not.toHaveBeenCalled();
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(totalChanges(h.db)).toBe(before);
  });

  it('refuses a null authority without contacting a proxy', async () => {
    const h = harness();
    h.authorityFor.mockReturnValue(null);
    const before = totalChanges(h.db);
    await expect(h.service.send(REQUEST)).resolves.toMatchObject({ state: 'refused', code: 'control_unavailable' });
    expect(h.authorityFor).toHaveBeenCalledExactlyOnceWith(providerProxySetIdentityFromRecord(EXECUTING));
    expect(h.sendOperation).not.toHaveBeenCalled();
    expect(totalChanges(h.db)).toBe(before);
  });

  it.each(['operation-control-outcome-unknown', 'operator-exit-fenced'] as const)(
    'translates a real %s authority hold without proxy contact',
    async (reason) => {
      const h = harness();
      const exchange = vi.fn<ControlClient['exchange']>();
      const authority = liveAuthority(EXECUTING, exchange);
      holdProviderProxyOperationControl(authority, reason);
      h.authorityFor.mockReturnValue(authority);
      const before = totalChanges(h.db);

      await expect(h.service.send(REQUEST)).resolves.toMatchObject({ state: 'refused', code: 'control_unavailable' });

      expect(exchange).not.toHaveBeenCalled();
      expect(totalChanges(h.db)).toBe(before);
    },
  );

  it.each<ProxyOperationSendResult>([
    DELIVERED,
    { state: 'refused', code: 'provider_rejected', reason: 'Provider declined the input verbatim' },
    { state: 'unknown', reason: 'The provider reply was lost' },
  ])('passes through $state unchanged with exactly one send and no durable writes', async (outcome) => {
    const h = harness();
    h.sendOperation.mockResolvedValue(outcome);
    const before = totalChanges(h.db);

    await expect(h.service.send(REQUEST)).resolves.toBe(outcome);

    expect(h.authorityFor).toHaveBeenCalledExactlyOnceWith(providerProxySetIdentityFromRecord(EXECUTING));
    expect(h.sendOperation).toHaveBeenCalledExactlyOnceWith(EXECUTING.operation, {
      text: REQUEST.input,
      clientMessageId: REQUEST.clientMessageId,
    });
    expect(totalChanges(h.db)).toBe(before);
    expect(readProviderOperationForJob(h.db, REQUEST.jobId)).toEqual(EXECUTING);
  });

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
      h.authorityFor.mockReturnValue(liveAuthority(EXECUTING, exchange));
      const before = totalChanges(h.db);

      const outcome = await h.service.send(REQUEST);
      expect(outcome).toEqual({
        state: 'refused',
        code: 'unsupported_by_running_build',
        reason:
          'The running Coral build predates jobs send. Restart the session so the current Coral plugin loads; the coordinator follows the installed build.',
      });

      const output = formatJobSendResult(REQUEST.jobId, outcome);
      expect(output.exitCode).toBe(1);
      expect(output.text).toContain('unsupported_by_running_build');
      expect(output.text).toContain('The running Coral build predates jobs send.');
      expect(output.text).toContain('Restart the session so the current Coral plugin loads');
      expect(output.text).not.toMatch(/retry|resend|command=|may have been delivered/i);
      expect(exchange).toHaveBeenCalledTimes(1);
      expect(totalChanges(h.db)).toBe(before);
      expect(readProviderOperationForJob(h.db, REQUEST.jobId)).toEqual(EXECUTING);
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

    const pending = h.service.send(REQUEST);

    expect(h.sendOperation).toHaveBeenCalledTimes(1);
    expect(totalChanges(h.db)).toBe(before);
    expect(readProviderOperationForJob(h.db, REQUEST.jobId)).toEqual(EXECUTING);
    answer(DELIVERED);
    await expect(pending).resolves.toBe(DELIVERED);
    expect(totalChanges(h.db)).toBe(before);
  });
});
