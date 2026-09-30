import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
  readLaunchAdmission,
  publishLaunchAdmission,
  launchAdmissionPath,
} from '#src/infra/launch-admission-record.js';
import { readDiscoveryRecordDisposition, writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { SHIPPED_RELEASE_TAGS } from '#tests/integration/coordinator/helpers.js';

describe('supervision identity compatibility', () => {
  it.each(SHIPPED_RELEASE_TAGS)('reads current-writer discovery with the actual %s reader', async (tag) => {
    const home = mkdtempSync(join(tmpdir(), 'coral-shipped-discovery-'));
    try {
      const outfile = join(home, 'reader.mjs');
      await build({
        entryPoints: ['shipped:src/infra/backend-discovery.ts'],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        plugins: [
          {
            name: 'shipped-tag-source',
            setup(builder) {
              builder.onResolve({ filter: /^shipped:/ }, ({ path }) => ({
                path: path.slice('shipped:'.length),
                namespace: 'shipped',
              }));
              builder.onResolve({ filter: /^\./, namespace: 'shipped' }, ({ path, importer }) => ({
                path: posix.join(posix.dirname(importer), path).replace(/\.js$/u, '.ts'),
                namespace: 'shipped',
              }));
              builder.onLoad({ filter: /.*/, namespace: 'shipped' }, ({ path }) => ({
                contents: execFileSync('git', ['show', `${tag}:${path}`], { encoding: 'utf8' }),
                loader: 'ts',
                resolveDir: process.cwd(),
              }));
            },
          },
        ],
      });
      const reader = (await import(pathToFileURL(outfile).href)) as {
        readBackendInfo: (runtime: ReturnType<typeof createRealRuntime>) => Record<string, unknown> | null;
      };
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      const record = {
        pid: process.pid,
        port: 12345,
        socketPath: join(home, 'coral.sock'),
        bundleHash: 'bundle',
        flavor: 'prod' as const,
        namespace: 'namespace',
        startedAt: Date.now(),
        token: 'token',
        bootToken: 'boot',
        version: '0.10.14',
        instanceId: 'current-writer',
        storeEpoch: '1',
        supervision: {
          version: 1 as const,
          launchId: '00000000-0000-4000-8000-000000000001',
          admittedAt: Date.now() - 1,
          buildSetId: 'known-build',
          purpose: 'startup' as const,
          parent: { pid: process.ppid, incarnation: 'parent' as ProcessIncarnation },
        },
      };
      expect(writeDiscoveryRecord(record, runtime)).toBe(true);
      const emitted = JSON.parse(readFileSync(runtime.paths.coral.coordinator.infoFile, 'utf8')) as object;
      const decoded = reader.readBackendInfo(runtime);
      expect(decoded).toMatchObject({
        pid: record.pid,
        port: record.port,
        socketPath: record.socketPath,
        bundleHash: record.bundleHash,
        namespace: record.namespace,
        token: record.token,
        bootToken: record.bootToken,
        version: record.version,
        instanceId: record.instanceId,
      });
      if (Number(tag.split('.').at(-1)) < 5) expect(decoded).not.toHaveProperty('supervision');
      else expect(decoded?.supervision).toEqual(record.supervision);
      writeFileSync(runtime.paths.coral.coordinator.infoFile, JSON.stringify({ ...emitted, pid: 'invalid' }));
      expect(reader.readBackendInfo(runtime)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the shipped v0.10.13 store schema fingerprint unchanged', () => {
    const manifest = JSON.parse(
      execFileSync('git', ['show', 'v0.10.13:clients/bridge/manifest.json'], {
        encoding: 'utf8',
      }),
    ) as { storeFormatFingerprint: string };
    expect(currentCoralStoreFormat().fingerprint).toBe(manifest.storeFormatFingerprint);
  });

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
