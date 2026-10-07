import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { errorCodeToExit } from '#src/cli/errors.js';
import type { JobDetailLookup } from '#src/jobs/contracts/addressing.js';
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

async function execute(method: 'jobs.abort', body: object, jobs: object): Promise<unknown> {
  const spec = rpcCatalog.find((candidate) => candidate.name === method);
  if (spec === undefined) throw new Error(`Missing RPC method ${method}.`);
  const ports = {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    admin: { isLaunchFenceActive: () => false },
    jobs,
  } as unknown as HttpHandlerPorts;
  const request = spec.requestSchema.parse({ ...body, projectRoot: PROJECT_ROOT });
  return executeCatalogRequest(spec, request, ports, testProjectPrincipal(PROJECT_ROOT));
}

describe('jobs.detail retained-epoch dispositions', () => {
  it('names maintenance or the next start as the unresolved job read exit', async () => {
    const result = await detailFor({ kind: 'unresolved', jobId: 'job-1', epochKey: 'lineage:7' });

    expect(result).toMatchObject({
      kind: 'unary',
      body: {
        code: 'job_unresolved',
        message: expect.stringContaining('scheduled maintenance retry or the next coordinator start') as unknown,
      },
    });
    expect(errorCodeToExit('job_unresolved', 409)).toBe(75);
  });

  it('reports an unreadable outcome as final for this coordinator lifetime', async () => {
    const result = await detailFor({ kind: 'outcome-unreadable', jobId: 'job-1', epochKey: 'lineage:7' });
    expect(result).toMatchObject({
      kind: 'unary',
      statusCode: 409,
      body: {
        code: 'job_outcome_unreadable',
        message: expect.stringContaining('next start'),
        detail: { epochKey: 'lineage:7' },
      },
    });
    expect(errorCodeToExit('job_outcome_unreadable', 409)).toBe(1);
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

  it.each(['jobs.abort'] as const)(
    'should answer %s on ids no epoch knows the way jobs.detail does',
    async (method) => {
      const jobs = {
        scopeCheck: () => ({ valid: ['job-1'], mismatch: [], missing: ['job-1'] }),
        unknownJobDisposition: () => 'pre-epoch-history',
        outcomeUnrecoverable: () => [],
      };
      const body = { jobs: ['job-1'] };

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

it('keeps the singular missing-job detail code when an epoch caveat is present', async () => {
  expect(await detailFor(null, 'Unreadable epoch retired: retained-store-root-missing.')).toMatchObject({
    kind: 'unary',
    body: { code: 'job_not_found', message: expect.stringContaining('retained-store-root-missing') },
  });
});
