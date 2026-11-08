import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { observeEpochKey } from '#src/store/epoch/key.js';
import { createRealRuntime } from '#src/runtime/real.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function epochFixture(files: Readonly<{ lock: boolean; marker: string | null }>) {
  const root = mkdtempSync(join(tmpdir(), 'coral-epoch-key-'));
  roots.push(root);
  const directory = join(root, 'epoch-3');
  mkdirSync(directory);
  if (files.lock) writeFileSync(join(directory, '.lock'), '');
  if (files.marker !== null) writeFileSync(join(directory, '.coral-lineage.v1.json'), files.marker);
  return {
    runtime: createRealRuntime('prod', { baseDir: root }),
    epoch: { storeRoot: root, epoch: '3', path: join(directory, 'store.db') },
  };
}

describe('observeEpochKey', () => {
  it('should read a present marker as the lineage key of that epoch', () => {
    const lineageId = '123e4567-e89b-42d3-a456-426614174000';
    const { runtime, epoch } = epochFixture({ lock: true, marker: JSON.stringify({ version: 'v1', lineageId }) });

    expect(observeEpochKey(runtime, epoch)).toEqual({ kind: 'present', key: `${lineageId}:3` });
  });

  it('should report a missing marker under a held epoch lock as absent', () => {
    const { runtime, epoch } = epochFixture({ lock: true, marker: null });

    expect(observeEpochKey(runtime, epoch)).toEqual({ kind: 'absent' });
  });

  it('should not report absent when the epoch directory moves away before its marker is read', () => {
    const { runtime, epoch } = epochFixture({
      lock: true,
      marker: JSON.stringify({ version: 'v1', lineageId: '123e4567-e89b-42d3-a456-426614174000' }),
    });
    const directory = dirname(epoch.path);
    const moving: typeof runtime.storage = {
      ...runtime.storage,
      readFileSync: ((path: string, encoding: 'utf-8') => {
        if (path.endsWith('.coral-lineage.v1.json')) renameSync(directory, `${directory}.protected`);
        return runtime.storage.readFileSync(path, encoding);
      }) as typeof runtime.storage.readFileSync,
    };

    expect(observeEpochKey({ storage: moving }, epoch)).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['a corrupt marker', { lock: true, marker: '{"version":"v1"' }],
    ['a missing epoch lock', { lock: false, marker: null }],
  ] as const)('should report %s as unreadable, never absent', (_case, files) => {
    const { runtime, epoch } = epochFixture(files);

    expect(observeEpochKey(runtime, epoch)).toEqual({ kind: 'unreadable' });
  });
});
