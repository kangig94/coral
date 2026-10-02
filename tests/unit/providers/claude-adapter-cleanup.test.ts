import { describe, expect, it, vi } from 'vitest';

import type { ArtifactCleanupRuntime } from '#src/providers/contract.js';
import { claudeArtifactCapability } from '#src/providers/claude/artifacts.js';
import { TEST_CLAUDE_ACCESS } from '../../helpers/provider-credentials.js';

function fakeTimerTime(): Pick<ArtifactCleanupRuntime['time'], 'sleep'> {
  return {
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

function protocolStorage(unlinkSync: ReturnType<typeof vi.fn>, existsSync: ReturnType<typeof vi.fn>) {
  const files = new Map<string, string>();
  return {
    unlinkSync,
    existsSync,
    mkdirSync: vi.fn(),
    readFileSync: (path: string) => {
      const value = files.get(path);
      if (value !== undefined) return value;
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
    writeAtomicSync: (path: string, value: string) => {
      files.set(path, value);
      return true;
    },
  };
}

const protocolPaths = {
  coral: { exports: { jobsRoot: '/tmp/coral/jobs' } },
} as ArtifactCleanupRuntime['paths'];

describe('claudeArtifactCapability.discardArtifacts', () => {
  it('removes a native log recreated during cleanup settling', async () => {
    vi.useFakeTimers();
    try {
      const handle = '/tmp/ref-a.jsonl';
      let exists = true;
      const unlinkSync = vi.fn(() => {
        exists = false;
      });
      const existsSync = vi.fn(() => exists);
      const runtime = {
        storage: protocolStorage(unlinkSync, existsSync),
        env: { homedir: () => '/home/user' },
        paths: protocolPaths,
        time: fakeTimerTime(),
      } as unknown as ArtifactCleanupRuntime;

      setTimeout(() => {
        exists = true;
      }, 250);
      const discard = claudeArtifactCapability.discardArtifacts({
        handles: [handle],
        actionId: 'test-action',
        payloadHash: 'test-payload',
        access: TEST_CLAUDE_ACCESS,
        runtime,
      });
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(500);

      await expect(discard).resolves.toEqual({ kind: 'discarded' });
      expect(unlinkSync.mock.calls).toEqual([[handle], [handle]]);
      expect(exists).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
