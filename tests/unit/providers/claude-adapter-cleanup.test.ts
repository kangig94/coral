import { describe, expect, it, vi } from 'vitest';

import type { ArtifactCleanupRuntime } from '#src/providers/contract.js';
import { claudeArtifactCapability } from '#src/providers/claude/provider-facets.js';

function makeRuntime(): {
  runtime: ArtifactCleanupRuntime;
  unlinkSync: ReturnType<typeof vi.fn>;
} {
  const unlinkSync = vi.fn();
  return {
    runtime: {
      storage: { unlinkSync },
      env: { homedir: () => '/home/user' },
    } as unknown as ArtifactCleanupRuntime,
    unlinkSync,
  };
}

describe('claudeArtifactCapability.discardArtifacts', () => {
  it('is a no-op for an empty handle list', async () => {
    const { runtime, unlinkSync } = makeRuntime();

    await expect(claudeArtifactCapability.discardArtifacts([], runtime)).resolves.toEqual({
      kind: 'skipped_no_handles',
    });

    expect(unlinkSync).not.toHaveBeenCalled();
  });

  it('unlinks only recorded handles passed by the caller', async () => {
    const { runtime, unlinkSync } = makeRuntime();

    await expect(
      claudeArtifactCapability.discardArtifacts(['/tmp/ref-a.jsonl', '/tmp/ref-b.jsonl'], runtime),
    ).resolves.toEqual({ kind: 'discarded' });

    expect(unlinkSync.mock.calls).toEqual([['/tmp/ref-a.jsonl'], ['/tmp/ref-b.jsonl']]);
  });

  it('swallows unlink failures and continues', async () => {
    const { runtime, unlinkSync } = makeRuntime();
    unlinkSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    await expect(
      claudeArtifactCapability.discardArtifacts(['/tmp/ref-a.jsonl', '/tmp/ref-b.jsonl'], runtime),
    ).resolves.toEqual({ kind: 'discarded' });

    expect(unlinkSync).toHaveBeenCalledTimes(2);
  });
});
