import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { JobAddressing } from '#src/jobs/addressing.js';
import { createRealTimePort } from '#src/infra/time.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { errorCodeToExit } from '#src/cli/errors.js';
import type { JobDetailLookup } from '#src/jobs/contracts/addressing.js';
import type { WaitStreamRequest } from '#src/jobs/wait/contract.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), 'coral-jobs-detail-'));
const PROJECT_ROOT = canonicalizeWorkDir(FIXTURE_ROOT, FIXTURE_ROOT);

afterAll(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

async function detailFor(lookup: JobDetailLookup, caveat?: string): Promise<unknown> {
  const spec = rpcCatalog.find((candidate) => candidate.name === 'jobs.detail');
  if (spec === undefined) throw new Error('Missing RPC method jobs.detail.');
  const ports = {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    admin: { isLaunchFenceActive: () => false },
    jobs: {
      scopeCheck: () => ({ mismatch: [], missing: [] }),
      detail: () => lookup,
      unknownJobDisposition: () => 'not-found',
      unknownJobCaveat: () => caveat,
    },
  } as unknown as HttpHandlerPorts;
  const request = spec.requestSchema.parse({ jobId: 'job-1', projectRoot: PROJECT_ROOT });
  return executeCatalogRequest(spec, request, ports, testProjectPrincipal(PROJECT_ROOT));
}

async function execute(method: 'jobs.wait' | 'jobs.abort', body: object, jobs: object): Promise<unknown> {
  const spec = rpcCatalog.find((candidate) => candidate.name === method);
  if (spec === undefined) throw new Error(`Missing RPC method ${method}.`);
  const supplied = jobs as HttpHandlerPorts['jobs'] & { outcomeUnrecoverable?(ids: readonly string[]): string[] };
  const fields = body as { jobIds?: string[] };
  const scope = supplied.scopeCheck(fields.jobIds ?? [], PROJECT_ROOT, 'contains');
  const unknown = supplied.unknownJobDisposition?.() ?? 'not-found';
  const unrecoverable = supplied.outcomeUnrecoverable?.(fields.jobIds ?? []) ?? [];
  const owner = new JobAddressing(
    {
      time: createRealTimePort(),
      read: (jobId: string) =>
        unrecoverable.includes(jobId)
          ? {
              version: 'v1',
              jobId,
              epochKey: 'old',
              subject: { projectRoot: PROJECT_ROOT, workDir: PROJECT_ROOT, jobKind: 'provider' },
              disposition: 'unresolved',
              detail: { kind: 'absent' },
            }
          : null,
      unknownLocationHolds: () =>
        unknown === 'discovery-unknown' || supplied.unknownJobCaveat
          ? [
              {
                epochKey: unknown === 'not-found' ? 'permanently-lost' : 'e',
                reason: unknown === 'not-found' ? 'retained-store-root-missing' : 'recovery retry pending',
                retryScheduled: unknown === 'discovery-unknown',
              },
            ]
          : [],
    } as never,
    {
      epochKey: () => 'e',
      detail: (jobId: string) => {
        if (scope.missing.includes(jobId) || unrecoverable.includes(jobId)) return null;
        const detail = admitted(jobId, [], false, 'e').detail!;
        detail.status.projectRoot = PROJECT_ROOT;
        detail.status.workDir = PROJECT_ROOT;
        return detail;
      },
    } as never,
    () => unknown === 'pre-epoch-history',
    () => 'decided',
    () => ({ kind: 'read', locations: new Map(unrecoverable.map((id) => [id, null])) }),
    () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
  );
  const validateWait = vi.isMockFunction(supplied.validateWait)
    ? vi.mocked(supplied.validateWait).mockImplementation(owner.validateWait.bind(owner))
    : owner.validateWait.bind(owner);
  const ports = {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    admin: { isLaunchFenceActive: () => false },
    jobs: method === 'jobs.wait' ? { ...supplied, admitWait: owner.admitWait.bind(owner), validateWait } : supplied,
  } as unknown as HttpHandlerPorts;
  const request = spec.requestSchema.parse({ ...body, projectRoot: PROJECT_ROOT });
  return executeCatalogRequest(spec, request, ports, testProjectPrincipal(PROJECT_ROOT));
}

describe('jobs.detail retained-epoch dispositions', () => {
  it('should tell the caller an unresolved job recovers on its own and is worth retrying', async () => {
    const result = await detailFor({ kind: 'unresolved', jobId: 'job-1', epochKey: 'lineage:7' });

    expect(result).toMatchObject({
      kind: 'unary',
      body: { code: 'job_unresolved', remediation: expect.stringContaining('recovery is automatic') as unknown },
    });
    expect(errorCodeToExit('job_unresolved', 409)).toBe(75);
  });

  it('should report an unreadable recorded detail distinctly from an unresolved job', async () => {
    const result = await detailFor({ kind: 'detail-unreadable', jobId: 'job-1', epochKey: 'lineage:7' });

    expect(result).toMatchObject({
      kind: 'unary',
      body: {
        code: 'job_detail_unreadable',
        message: expect.stringContaining('retrying with this build will not change that') as unknown,
        detail: { epochKey: 'lineage:7' },
      },
    });
    expect(errorCodeToExit('job_detail_unreadable', 409)).toBe(1);
  });

  it('should answer a job no recorded terminal will reach as final, not as a retry', async () => {
    const result = await detailFor({ kind: 'outcome-unrecoverable', jobId: 'job-1', epochKey: 'lineage:7' });

    expect(result).toMatchObject({
      kind: 'unary',
      body: { code: 'job_outcome_unrecoverable', detail: { epochKey: 'lineage:7' } },
    });
    expect(JSON.stringify(result)).not.toMatch(/retry shortly|recovery is automatic/i);
    expect(errorCodeToExit('job_outcome_unrecoverable', 409)).toBe(1);
  });

  it('should refuse to open a wait on a job no recorded terminal will reach', async () => {
    const waitStream = vi.fn();
    const result = await execute(
      'jobs.wait',
      { jobIds: ['job-1', 'job-2'] },
      {
        scopeCheck: () => ({ valid: ['job-1', 'job-2'], mismatch: [], missing: [] }),
        outcomeUnrecoverable: () => ['job-2'],
        validateWait: () => null,
        waitStream,
      },
    );

    expect(result).toMatchObject({
      kind: 'unary',
      body: { code: 'job_outcome_unrecoverable', detail: { jobs: ['job-2'] } },
    });
    expect(waitStream).not.toHaveBeenCalled();
  });

  it.each(['jobs.wait', 'jobs.abort'] as const)(
    'should answer %s on ids no epoch knows the way jobs.detail does',
    async (method) => {
      const jobs = {
        scopeCheck: () => ({ valid: ['job-1'], mismatch: [], missing: ['job-1'] }),
        unknownJobDisposition: () => 'pre-epoch-history',
        outcomeUnrecoverable: () => [],
      };
      const body = method === 'jobs.wait' ? { jobIds: ['job-1'] } : { jobs: ['job-1'] };

      expect(await execute(method, body, jobs)).toMatchObject({
        kind: 'unary',
        body: { code: 'job_pre_epoch_history' },
      });
      expect(await execute(method, body, { ...jobs, unknownJobDisposition: () => 'not-found' })).toMatchObject({
        kind: 'unary',
        body: { code: 'jobs_not_found' },
      });
    },
  );

  it('should give missing ids in a mixed wait the pre-epoch disposition before streaming', async () => {
    const waitStream = vi.fn();
    const result = await execute(
      'jobs.wait',
      { jobIds: ['known', 'possible-flat'] },
      {
        scopeCheck: () => ({ valid: ['known', 'possible-flat'], mismatch: [], missing: ['possible-flat'] }),
        unknownJobDisposition: () => 'pre-epoch-history',
        outcomeUnrecoverable: () => [],
        validateWait: () => null,
        waitStream,
      },
    );

    expect(result).toMatchObject({
      kind: 'unary',
      statusCode: 404,
      body: { code: 'job_pre_epoch_history', detail: { jobs: ['possible-flat'] } },
    });
    expect(waitStream).not.toHaveBeenCalled();
  });

  it('should let addressing answer each id in a mixed pre-epoch abort', async () => {
    const abort = vi.fn(() => ({
      kind: 'answered' as const,
      result: {
        aborted: ['known'],
        notFound: [],
        refused: [{ jobId: 'possible-flat', reason: 'job_pre_epoch_history', nextStep: 'Do not retry.' }],
      },
    }));
    const result = await execute(
      'jobs.abort',
      { jobs: ['known', 'possible-flat'] },
      {
        scopeCheck: () => ({ valid: ['known', 'possible-flat'], mismatch: [], missing: ['possible-flat'] }),
        abort,
      },
    );

    expect(abort).toHaveBeenCalledWith(['known', 'possible-flat']);
    expect(result).toMatchObject({
      kind: 'unary',
      body: {
        aborted: ['known'],
        notFound: [],
        refused: [{ jobId: 'possible-flat', reason: 'job_pre_epoch_history' }],
      },
    });
  });
});

it('maps jobs-owned admission without filtering the request or its saved cursor', async () => {
  const validateWait = vi.fn(() => null);
  const cursor = {
    version: 'jobs.wait.v2',
    positions: { e: 12, missing: 9 },
    locations: { known: 'e', ghost: 'missing' },
    deliveredJobIds: ['ghost'],
  };
  const waitStream = vi.fn(async function* (request: WaitStreamRequest) {
    yield {
      type: 'waiting' as const,
      waitingJobIds: request.admissions?.filter((job) => job.disposition === 'admitted').map((job) => job.jobId) ?? [],
    };
  });
  const result = await execute(
    'jobs.wait',
    { jobIds: ['known', 'ghost'], cursor, supportsWaitV2: true, supportsWaitV3: true },
    {
      scopeCheck: () => ({ valid: ['known', 'ghost'], mismatch: [], missing: ['ghost'] }),
      unknownJobDisposition: () => 'not-found',
      outcomeUnrecoverable: () => [],
      validateWait,
      waitStream,
    },
  );
  expect(result).toMatchObject({ kind: 'subscription' });
  expect(validateWait).toHaveBeenCalledWith(
    expect.objectContaining({
      jobIds: ['known', 'ghost'],
      cursor,
      admissions: [
        expect.objectContaining({ jobId: 'known', disposition: 'admitted' }),
        { jobId: 'ghost', disposition: 'missing', message: undefined },
      ],
    }),
  );
  const stream = (result as { notifications: AsyncIterable<unknown> }).notifications;
  for await (const event of stream) expect(event).toMatchObject({ waitingJobIds: ['known'] });
  expect(waitStream.mock.calls[0][0]).toMatchObject({ jobIds: ['known', 'ghost'], cursor });
});

it.each([false, true])('keeps retryable unknown discovery resumable in a legacy %s mixed wait', async (mixed) => {
  const ids = mixed ? ['known', 'unknown'] : ['unknown'];
  const cursor = { version: 'jobs.wait.v2', positions: { e: 12 }, locations: { known: 'e' } };
  const result = await execute(
    'jobs.wait',
    { jobIds: ids, cursor, supportsWaitV2: true },
    {
      scopeCheck: () => ({ valid: ids, mismatch: [], missing: ['unknown'] }),
      unknownJobDisposition: () => 'discovery-unknown',
      unknownJobCaveat: () => 'Unreadable epoch e: recovery retry pending.',
    },
  );
  expect(result).toMatchObject({
    kind: 'unary',
    statusCode: 503,
    body: {
      code: 'transient',
      detail: { jobs: ids, disposition: 'discovery-unknown' },
      remediation: `coral-cli wait jobs ${ids.join(' ')} --cursor ${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`,
    },
  });
  expect(errorCodeToExit('transient', 503)).toBe(75);
});

it('answers a typo as missing with the permanent unreadable-epoch caveat', async () => {
  const result = await execute(
    'jobs.wait',
    { jobIds: ['typo'] },
    {
      scopeCheck: () => ({ valid: ['typo'], mismatch: [], missing: ['typo'] }),
      unknownJobDisposition: () => 'not-found',
      unknownJobCaveat: () => 'Unreadable epoch permanently-lost: retained-store-root-missing.',
    },
  );
  expect(result).toMatchObject({
    kind: 'unary',
    statusCode: 404,
    body: { code: 'jobs_not_found', message: expect.stringContaining('permanently-lost: retained-store-root-missing') },
  });
  expect(errorCodeToExit('jobs_not_found', 404)).toBe(1);
});

it('keeps the singular missing-job detail code when an epoch caveat is present', async () => {
  expect(await detailFor(null, 'Unreadable epoch retired: retained-store-root-missing.')).toMatchObject({
    kind: 'unary',
    body: { code: 'job_not_found', message: expect.stringContaining('retained-store-root-missing') },
  });
});
