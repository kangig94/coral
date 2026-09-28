import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  latestControllerOpen,
  recordControllerOpen,
  recordControllerServing,
} from '#src/coordinator/succession/controller-open.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';

const EPOCH_KEY = '00000000-0000-4000-8000-000000000007:7';
const BUILD = {
  version: '0.10.14',
  buildSetId: '123e4567-e89b-42d3-a456-426614174000',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
} as const;
const roots: string[] = [];

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000002';

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function emptyRuntime(): Runtime {
  const root = mkdtempSync(join(tmpdir(), 'coral-controller-open-'));
  roots.push(root);
  return createRealRuntime('prod', { baseDir: root });
}

function openAt(
  runtime: Runtime,
  openedAtMs: number,
  instanceId: string,
  generation: number,
  attemptId: string | null = null,
) {
  vi.spyOn(runtime.time, 'now').mockReturnValue(openedAtMs);
  recordControllerOpen(runtime, EPOCH_KEY, instanceId, attemptId, '/plugin', BUILD, generation);
}

function servingPath(runtime: Runtime): string {
  return join(runtime.paths.coral.coordinator.runDir, 'controller-opens.v1', 'served', `${ATTEMPT_ID}.json`);
}

function fixture(): { runtime: Runtime; directory: string } {
  const root = mkdtempSync(join(tmpdir(), 'coral-controller-open-'));
  roots.push(root);
  const runtime = createRealRuntime('prod', { baseDir: root });
  recordControllerOpen(runtime, EPOCH_KEY, 'instance-a', null, '/plugin', BUILD, 3);
  const directory = join(runtime.paths.coral.coordinator.runDir, 'controller-opens.v1', runtime.ids.sha256(EPOCH_KEY));
  return { runtime, directory };
}

describe('controller-open records', () => {
  it('should read a record a newer build extended with an unknown field', () => {
    const { runtime, directory } = fixture();
    const [name] = readdirSync(directory);
    const record = JSON.parse(readFileSync(join(directory, name), 'utf-8')) as Record<string, unknown>;
    writeFileSync(join(directory, name), `${JSON.stringify({ ...record, laterField: true })}\n`);

    expect(latestControllerOpen(runtime, EPOCH_KEY)).toMatchObject({
      latest: { instanceId: 'instance-a', controlGeneration: 3 },
      unreadable: [],
    });
  });

  it('should keep readable records and name an unreadable one instead of discarding the set', () => {
    const { runtime, directory } = fixture();
    const corrupt = join(directory, '9999999999999-corrupt.json');
    writeFileSync(corrupt, '{"version":');

    expect(latestControllerOpen(runtime, EPOCH_KEY)).toMatchObject({
      latest: { instanceId: 'instance-a' },
      unreadable: [corrupt],
    });
  });

  it('should report no controller and nothing unreadable when the epoch has no records', () => {
    expect(latestControllerOpen(emptyRuntime(), EPOCH_KEY)).toEqual({ latest: null, unreadable: [] });
  });

  it('should name a record filed under the epoch that claims another epoch as unreadable', () => {
    const { runtime, directory } = fixture();
    const [name] = readdirSync(directory);
    const record = JSON.parse(readFileSync(join(directory, name), 'utf-8')) as Record<string, unknown>;
    writeFileSync(join(directory, name), `${JSON.stringify({ ...record, epochKey: 'another:1' })}\n`);

    expect(latestControllerOpen(runtime, EPOCH_KEY)).toEqual({ latest: null, unreadable: [join(directory, name)] });
  });

  it('should rank by control generation before open time, and by open time within one generation', () => {
    const runtime = emptyRuntime();
    openAt(runtime, 1_000, 'older-higher', 5);
    openAt(runtime, 2_000, 'newer-lower', 4);
    expect(latestControllerOpen(runtime, EPOCH_KEY).latest).toMatchObject({ instanceId: 'older-higher' });

    openAt(runtime, 3_000, 'newest-same', 5);
    expect(latestControllerOpen(runtime, EPOCH_KEY).latest).toMatchObject({ instanceId: 'newest-same' });
    expect(latestControllerOpen(runtime, EPOCH_KEY, 'newer-lower').latest).toMatchObject({ instanceId: 'newer-lower' });
  });

  it('should count an attempt-bound open only once its serving record names that open', () => {
    const runtime = emptyRuntime();
    openAt(runtime, 1_000, 'incumbent', 3);
    openAt(runtime, 2_000, 'successor', 4, ATTEMPT_ID);
    expect(latestControllerOpen(runtime, EPOCH_KEY)).toMatchObject({
      latest: { instanceId: 'incumbent' },
      unreadable: [],
    });

    recordControllerServing(runtime, ATTEMPT_ID, EPOCH_KEY, 'another-successor', 4);
    expect(latestControllerOpen(runtime, EPOCH_KEY).latest).toMatchObject({ instanceId: 'incumbent' });

    recordControllerServing(runtime, ATTEMPT_ID, EPOCH_KEY, 'successor', 4);
    const served = JSON.parse(readFileSync(servingPath(runtime), 'utf-8')) as Record<string, unknown>;
    writeFileSync(servingPath(runtime), `${JSON.stringify({ ...served, laterField: true })}\n`);
    recordControllerServing(runtime, ATTEMPT_ID, EPOCH_KEY, 'successor', 4);
    expect(JSON.parse(readFileSync(servingPath(runtime), 'utf-8'))).toMatchObject({ laterField: true });
    expect(latestControllerOpen(runtime, EPOCH_KEY)).toMatchObject({
      latest: { instanceId: 'successor' },
      unreadable: [],
    });
  });

  it('should name an unreadable serving record rather than fall back to an earlier controller silently', () => {
    const runtime = emptyRuntime();
    openAt(runtime, 1_000, 'incumbent', 3);
    openAt(runtime, 2_000, 'successor', 4, ATTEMPT_ID);
    recordControllerServing(runtime, ATTEMPT_ID, EPOCH_KEY, 'successor', 4);
    writeFileSync(servingPath(runtime), '{"version":');

    expect(latestControllerOpen(runtime, EPOCH_KEY)).toEqual({
      latest: expect.objectContaining({ instanceId: 'incumbent' }),
      unreadable: [servingPath(runtime)],
    });
  });
});
