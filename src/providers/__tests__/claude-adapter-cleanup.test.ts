import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { ArtifactCleanupRuntime } from '../types.js';
import type { RuntimeDirentLike, RuntimeEnv, RuntimeStorage } from '../../shared/runtime-ports.js';
import { claudeProvider } from '../claude/adapter.js';

function makeDirent(name: string, kind: 'file' | 'dir'): RuntimeDirentLike {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

function makeRuntime(tree: Record<string, RuntimeDirentLike[]>, homedir = '/home/user'): {
  runtime: ArtifactCleanupRuntime;
  unlinkSync: ReturnType<typeof vi.fn>;
  existsSync: ReturnType<typeof vi.fn>;
} {
  const unlinkSync = vi.fn();
  const existsSync = vi.fn((path: string) => Object.prototype.hasOwnProperty.call(tree, path));
  const readdirSync = vi.fn((path: string) => tree[path] ?? []);

  const storage = {
    existsSync,
    readdirSync,
    unlinkSync,
  } as unknown as RuntimeStorage;

  const env = {
    homedir: () => homedir,
  } as unknown as RuntimeEnv;

  return { runtime: { storage, env }, unlinkSync, existsSync };
}

describe('claudeProvider.artifactCleanup.cleanupSessions', () => {
  const projectsDir = '/home/user/.claude/projects';

  it('is a no-op for an empty ref list', async () => {
    const { runtime, unlinkSync, existsSync } = makeRuntime({});
    await claudeProvider.artifactCleanup?.cleanupSessions(runtime, []);
    expect(unlinkSync).not.toHaveBeenCalled();
    expect(existsSync).not.toHaveBeenCalled();
  });

  it('returns early when the projects directory does not exist', async () => {
    const { runtime, unlinkSync } = makeRuntime({});
    await claudeProvider.artifactCleanup?.cleanupSessions(runtime, ['ref-a']);
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('unlinks matching .jsonl files across all project subdirectories', async () => {
    const tree = {
      [projectsDir]: [
        makeDirent('-home-user-proj-a', 'dir'),
        makeDirent('-home-user-proj-b', 'dir'),
        makeDirent('stray-file', 'file'),
      ],
      [join(projectsDir, '-home-user-proj-a')]: [
        makeDirent('ref-a.jsonl', 'file'),
        makeDirent('other.jsonl', 'file'),
      ],
      [join(projectsDir, '-home-user-proj-b')]: [
        makeDirent('ref-b.jsonl', 'file'),
        makeDirent('subdir', 'dir'),
      ],
    };
    const { runtime, unlinkSync } = makeRuntime(tree);

    await claudeProvider.artifactCleanup?.cleanupSessions(runtime, ['ref-a', 'ref-b']);

    expect(unlinkSync).toHaveBeenCalledTimes(2);
    expect(unlinkSync).toHaveBeenCalledWith(join(projectsDir, '-home-user-proj-a', 'ref-a.jsonl'));
    expect(unlinkSync).toHaveBeenCalledWith(join(projectsDir, '-home-user-proj-b', 'ref-b.jsonl'));
  });

  it('skips non-directory entries at the projects root', async () => {
    const tree = {
      [projectsDir]: [makeDirent('some-file', 'file')],
    };
    const { runtime, unlinkSync } = makeRuntime(tree);

    await claudeProvider.artifactCleanup?.cleanupSessions(runtime, ['ref-a']);
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('does not unlink non-matching filenames or nested directories named like a target', async () => {
    const tree = {
      [projectsDir]: [makeDirent('-proj', 'dir')],
      [join(projectsDir, '-proj')]: [
        makeDirent('other.jsonl', 'file'),
        makeDirent('ref-a.jsonl', 'dir'),
      ],
    };
    const { runtime, unlinkSync } = makeRuntime(tree);

    await claudeProvider.artifactCleanup?.cleanupSessions(runtime, ['ref-a']);
    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('swallows unlink failures and continues', async () => {
    const tree = {
      [projectsDir]: [makeDirent('-proj', 'dir')],
      [join(projectsDir, '-proj')]: [
        makeDirent('ref-a.jsonl', 'file'),
        makeDirent('ref-b.jsonl', 'file'),
      ],
    };
    const { runtime, unlinkSync } = makeRuntime(tree);
    unlinkSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    await expect(claudeProvider.artifactCleanup?.cleanupSessions(runtime, ['ref-a', 'ref-b'])).resolves.toBeUndefined();
    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });
});
