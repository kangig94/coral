import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { JobLocationIndex } from '#src/jobs/location-index.js';
import type { JobDetailResponse } from '#src/jobs/records.js';
import { createRealRuntime } from '#src/runtime/real.js';

const runtime = createRealRuntime('prod', { baseDir: tmpdir() });
const directories: string[] = [];

function fixture(): { root: string; index: JobLocationIndex } {
  const root = mkdtempSync(join(tmpdir(), 'coral-red-job-location-'));
  directories.push(root);
  return { root, index: new JobLocationIndex(runtime, root) };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('job location additive records', () => {
  it('preserves a newer nested subject field while recording an unresolved outcome', () => {
    const { root, index } = fixture();
    index.register('job-1', 'lineage-1:1', {
      projectRoot: '/workspace/project',
      workDir: '/workspace/project',
      jobKind: 'provider',
    });
    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from('job-1').toString('base64url')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8')) as { subject: Record<string, unknown> };
    writeFileSync(path, `${JSON.stringify({ ...record, subject: { ...record.subject, futureScope: 'tenant-a' } })}\n`);

    index.markUnresolved('job-1');

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      disposition: 'unresolved',
      subject: { futureScope: 'tenant-a' },
    });
  });

  it('preserves newer nested subject and controller fields through terminal recording', () => {
    const { root, index } = fixture();
    index.register(
      'job-1',
      'lineage-1:1',
      {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      },
      { buildSetId: 'build-1', instanceId: 'controller-1', controlGeneration: 1 },
    );
    const path = join(root, 'job-locations.v1', 'jobs', `${Buffer.from('job-1').toString('base64url')}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8')) as {
      subject: Record<string, unknown>;
      controller: Record<string, unknown>;
    };
    writeFileSync(
      path,
      `${JSON.stringify({
        ...record,
        subject: { ...record.subject, futureScope: 'tenant-a' },
        controller: { ...record.controller, futureLease: 'lease-a' },
      })}\n`,
    );

    index.recordTerminal(
      'job-1',
      {
        status: {
          projectRoot: '/workspace/project',
          workDir: '/workspace/project',
          jobKind: 'provider',
        },
      } as JobDetailResponse,
      join(root, 'result.md'),
      2,
    );

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      disposition: 'terminal',
      subject: { futureScope: 'tenant-a' },
      controller: { futureLease: 'lease-a' },
    });
  });
});
