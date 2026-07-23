import { describe, expect, it, vi } from 'vitest';

import type { ArtifactCleanupRuntime } from '#src/providers/contract.js';
import { claudeArtifactCapability } from '#src/providers/claude/artifacts.js';
import { TEST_CLAUDE_ACCESS } from '../../helpers/provider-credentials.js';

const immediateTime = {
  sleep: async () => {},
};

function fakeTimerTime(): Pick<ArtifactCleanupRuntime['time'], 'sleep'> {
  return {
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

function makeRuntime(): {
  runtime: ArtifactCleanupRuntime;
  unlinkSync: ReturnType<typeof vi.fn>;
  existsSync: ReturnType<typeof vi.fn>;
} {
  const unlinkSync = vi.fn();
  const existsSync = vi.fn(() => false);
  return {
    runtime: {
      storage: { unlinkSync, existsSync },
      env: { homedir: () => '/home/user' },
      time: immediateTime,
    } as unknown as ArtifactCleanupRuntime,
    unlinkSync,
    existsSync,
  };
}

describe('claudeArtifactCapability.discardArtifacts', () => {
  it('is a no-op for an empty handle list', async () => {
    const { runtime, unlinkSync } = makeRuntime();

    await expect(
      claudeArtifactCapability.discardArtifacts({ handles: [], access: TEST_CLAUDE_ACCESS, runtime }),
    ).resolves.toEqual({
      kind: 'skipped_no_handles',
    });

    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('unlinks only recorded handles passed by the caller', async () => {
    const { runtime, unlinkSync } = makeRuntime();

    await expect(
      claudeArtifactCapability.discardArtifacts({
        handles: ['/tmp/ref-a.jsonl', '/tmp/ref-b.jsonl'],
        access: TEST_CLAUDE_ACCESS,
        runtime,
      }),
    ).resolves.toEqual({ kind: 'discarded' });

    expect(unlinkSync.mock.calls).toEqual([['/tmp/ref-a.jsonl'], ['/tmp/ref-b.jsonl']]);
  });

  it('swallows unlink failures and continues', async () => {
    const { runtime, unlinkSync } = makeRuntime();
    unlinkSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    await expect(
      claudeArtifactCapability.discardArtifacts({
        handles: ['/tmp/ref-a.jsonl', '/tmp/ref-b.jsonl'],
        access: TEST_CLAUDE_ACCESS,
        runtime,
      }),
    ).resolves.toEqual({ kind: 'discarded' });

    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });

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
        storage: { unlinkSync, existsSync },
        env: { homedir: () => '/home/user' },
        time: fakeTimerTime(),
      } as unknown as ArtifactCleanupRuntime;

      setTimeout(() => {
        exists = true;
      }, 250);
      const discard = claudeArtifactCapability.discardArtifacts({
        handles: [handle],
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
