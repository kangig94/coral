import { proveResultArtifactDurable } from '#src/jobs/terminal/artifact.js';
import type { StorageBigIntStat } from '#src/infra/port-types.js';
import { describe, expect, it, vi } from 'vitest';

const jobsRoot = '/coral/exports/jobs';
const resultPath = `${jobsRoot}/a/executions/1/result.md`;

function fakeStorage(stat: { ctimeNs: bigint | undefined; size?: bigint }) {
  const file = (): StorageBigIntStat => ({
    dev: 1n,
    ino: 2n,
    nlink: 1n,
    mode: 0o100644n,
    size: stat.size ?? 10n,
    mtimeNs: 5n,
    ctimeNs: stat.ctimeNs,
    isDirectory: () => false,
    isFile: () => true,
  });
  return {
    openSync: vi.fn(() => 3),
    fstatSync: vi.fn(file),
    fdatasyncSync: vi.fn(),
    syncDirectoryDurableSync: vi.fn((_directory: string) => true),
    closeSync: vi.fn(),
  };
}

describe('proveResultArtifactDurable', () => {
  it('should force every directory naming the artifact up to the exports root', () => {
    const storage = fakeStorage({ ctimeNs: 7n });

    expect(proveResultArtifactDurable(storage, resultPath, jobsRoot)).toBe(true);
    expect(storage.syncDirectoryDurableSync.mock.calls.map(([directory]) => directory)).toEqual([
      `${jobsRoot}/a/executions/1`,
      `${jobsRoot}/a/executions`,
      `${jobsRoot}/a`,
      jobsRoot,
      '/coral/exports',
    ]);
  });

  it('should force an unchanged artifact only once and force it again after it changes', () => {
    const stat = { ctimeNs: 7n };
    const storage = fakeStorage(stat);
    const prove = () => proveResultArtifactDurable(storage, resultPath, jobsRoot);

    expect([prove(), prove()]).toEqual([true, true]);
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(1);

    stat.ctimeNs = 8n;
    expect(prove()).toBe(true);
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(2);
  });

  it('should force every proof when the stat cannot show the artifact unchanged', () => {
    const storage = fakeStorage({ ctimeNs: undefined });
    const prove = () => proveResultArtifactDurable(storage, resultPath, jobsRoot);

    prove();
    prove();
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(2);
  });

  it('should forget a proof once the artifact fails to prove, even after it is restored unchanged', () => {
    const stat: { ctimeNs: bigint; size?: bigint } = { ctimeNs: 7n };
    const storage = fakeStorage(stat);
    const prove = () => proveResultArtifactDurable(storage, resultPath, jobsRoot);

    prove();
    stat.size = 0n;
    expect(prove()).toBe(false);
    delete stat.size;
    expect(prove()).toBe(true);
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(2);
  });

  it('should not remember a proof whose directories could not be forced', () => {
    const storage = fakeStorage({ ctimeNs: 7n });
    storage.syncDirectoryDurableSync.mockReturnValueOnce(false);
    const prove = () => proveResultArtifactDurable(storage, resultPath, jobsRoot);

    expect([prove(), prove()]).toEqual([false, true]);
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(2);
  });
});
