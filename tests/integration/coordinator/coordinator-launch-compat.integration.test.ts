import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readLaunchAdmission,
  publishLaunchAdmission,
  launchAdmissionPath,
} from '#src/infra/launch-admission-record.js';
import { readDiscoveryRecordDisposition } from '#src/infra/backend-discovery.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';

describe('supervision identity compatibility', () => {
  it('preserves unknown child admission fields while reading the exact child', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-admission-shape-'));
    const launchId = '00000000-0000-4000-8000-000000000001';
    try {
      publishLaunchAdmission(runDir, {
        version: 1,
        launchId,
        child: { pid: 201, incarnation: 'child' as ProcessIncarnation },
        parent: { pid: 101, incarnation: 'parent' as ProcessIncarnation },
        admittedAt: 1_000,
        build: { version: '0.10.14', buildSetId: 'known-build', bundleHash: 'known-hash', flavor: 'prod' },
        purpose: 'startup',
      });
      const path = launchAdmissionPath(runDir, launchId);
      const withFutureField = {
        ...(JSON.parse(readFileSync(path, 'utf8')) as object),
        futureAdmissionProof: { generation: 2 },
      };
      writeFileSync(path, JSON.stringify(withFutureField));
      expect(readLaunchAdmission(runDir, launchId)).toMatchObject({
        kind: 'readable',
        admission: {
          ...withFutureField,
          child: { pid: 201, incarnation: 'child' },
          parent: { pid: 101, incarnation: 'parent' },
        },
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('preserves additive supervision identity and unknown fields with the current discovery reader', () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-supervision-discovery-'));
    try {
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      const path = runtime.paths.coral.coordinator.infoFile;
      mkdirSync(runtime.paths.coral.coordinator.runDir, { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          pid: 201,
          port: 12345,
          socketPath: '/tmp/coral.sock',
          bundleHash: 'bundle',
          flavor: 'prod',
          namespace: 'namespace',
          startedAt: 1_000,
          token: 'token',
          bootToken: 'boot',
          supervision: {
            version: 1,
            launchId: '00000000-0000-4000-8000-000000000001',
            admittedAt: 999,
            buildSetId: 'known-build',
            purpose: 'startup',
            parent: { pid: 101, incarnation: 'parent' },
            futureOwnerProof: { generation: 2 },
          },
        }),
      );
      expect(readDiscoveryRecordDisposition(runtime)).toMatchObject({
        kind: 'record',
        record: {
          pid: 201,
          supervision: { buildSetId: 'known-build', futureOwnerProof: { generation: 2 } },
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
