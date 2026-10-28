import { proveResultArtifactsDurable, proveResultArtifactsDurableAsync } from '#src/jobs/terminal/artifact.js';
import type { StorageBigIntStat, StoragePort } from '#src/infra/port-types.js';
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
    statSync: (() => file()) as unknown as StoragePort['statSync'],
    openSync: vi.fn(() => 3),
    fstatSync: vi.fn(file),
    fdatasyncSync: vi.fn(),
    syncDirectoryDurableSync: vi.fn((_directory: string) => true),
    closeSync: vi.fn(),
    syncFileDataDurable: vi.fn(async (_path: string) => true),
    syncDirectoryDurable: vi.fn(async (_directory: string) => true),
  };
}

describe('proveResultArtifactsDurable', () => {
  it('should force every directory naming the artifacts once, up to the exports root', () => {
    const storage = fakeStorage({ ctimeNs: 7n });

    expect(proveResultArtifactsDurable(storage, [resultPath, `${jobsRoot}/b/result.md`], jobsRoot)).toBe(true);
    expect(storage.syncDirectoryDurableSync.mock.calls.map(([directory]) => directory)).toEqual([
      `${jobsRoot}/a/executions/1`,
      `${jobsRoot}/a/executions`,
      `${jobsRoot}/a`,
      jobsRoot,
      '/coral/exports',
      `${jobsRoot}/b`,
    ]);
  });

  it('should force an unchanged artifact only once and force it again after it changes', () => {
    const stat = { ctimeNs: 7n };
    const storage = fakeStorage(stat);
    const prove = () => proveResultArtifactsDurable(storage, [resultPath], jobsRoot);

    expect([prove(), prove()]).toEqual([true, true]);
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(1);

    stat.ctimeNs = 8n;
    expect(prove()).toBe(true);
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(2);
  });

  it('should force every proof when the stat cannot show the artifact unchanged', () => {
    const storage = fakeStorage({ ctimeNs: undefined });
    const prove = () => proveResultArtifactsDurable(storage, [resultPath], jobsRoot);

    prove();
    prove();
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(2);
  });

  it('should forget a proof once the artifact fails to prove, even after it is restored unchanged', () => {
    const stat: { ctimeNs: bigint; size?: bigint } = { ctimeNs: 7n };
    const storage = fakeStorage(stat);
    const prove = () => proveResultArtifactsDurable(storage, [resultPath], jobsRoot);

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
    const prove = () => proveResultArtifactsDurable(storage, [resultPath], jobsRoot);

    expect([prove(), prove()]).toEqual([false, true]);
    expect(storage.fdatasyncSync).toHaveBeenCalledTimes(2);
  });
});

describe('proveResultArtifactsDurableAsync', () => {
  it('should force off the event loop and share the proof with the synchronous form', async () => {
    const storage = fakeStorage({ ctimeNs: 7n });

    await expect(
      proveResultArtifactsDurableAsync(storage, [resultPath], jobsRoot, new AbortController().signal),
    ).resolves.toBe(true);
    expect(proveResultArtifactsDurable(storage, [resultPath], jobsRoot)).toBe(true);
    expect(storage.syncFileDataDurable).toHaveBeenCalledOnce();
    expect(storage.fdatasyncSync).not.toHaveBeenCalled();
    expect(storage.syncDirectoryDurableSync).not.toHaveBeenCalled();
  });

  it('should keep the artifacts it finished when a proof stops part way', async () => {
    const storage = fakeStorage({ ctimeNs: 7n });
    const second = `${jobsRoot}/b/result.md`;
    const stop = new AbortController();
    storage.syncFileDataDurable.mockImplementation(async (path) => {
      if (path === second) stop.abort();
      return true;
    });

    await expect(proveResultArtifactsDurableAsync(storage, [resultPath, second], jobsRoot, stop.signal)).resolves.toBe(
      false,
    );
    await expect(
      proveResultArtifactsDurableAsync(storage, [resultPath, second], jobsRoot, new AbortController().signal),
    ).resolves.toBe(true);
    expect(storage.syncFileDataDurable.mock.calls.map(([path]) => path)).toEqual([resultPath, second, second]);
  });

  it('should leave an artifact that changes while it is forced unproven', async () => {
    const stat = { ctimeNs: 7n };
    const storage = fakeStorage(stat);
    storage.syncFileDataDurable.mockImplementationOnce(async () => {
      stat.ctimeNs = 8n;
      return true;
    });
    const prove = () => proveResultArtifactsDurableAsync(storage, [resultPath], jobsRoot, new AbortController().signal);

    await expect(prove()).resolves.toBe(false);
    await expect(prove()).resolves.toBe(true);
    expect(storage.syncFileDataDurable).toHaveBeenCalledTimes(2);
  });
});
