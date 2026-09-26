import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

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

async function detailFor(lookup: JobDetailLookup): Promise<unknown> {
  const spec = rpcCatalog.find((candidate) => candidate.name === 'jobs.detail');
  if (spec === undefined) throw new Error('Missing RPC method jobs.detail.');
  const ports = {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    admin: { isLaunchFenceActive: () => false },
    jobs: {
      scopeCheck: () => ({ mismatch: [], missing: [] }),
      detail: () => lookup,
    },
  } as unknown as HttpHandlerPorts;
  const request = spec.requestSchema.parse({ jobId: 'job-1', projectRoot: PROJECT_ROOT });
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
      body: { code: 'job_detail_unreadable', detail: { epochKey: 'lineage:7' } },
    });
    expect(errorCodeToExit('job_detail_unreadable', 409)).toBe(1);
  });
});
