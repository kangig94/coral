import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { bindProviderRunner, type ProviderDurableSpawner } from '#src/providers/cli-runner.js';

const NO_CLI_RESULT = { stdout: '', stderr: '', code: 0, aborted: false };

describe('bindProviderRunner', () => {
  it('forwards the durable identity callback and exact job identity to the spawner', async () => {
    let capturedOptionsHadCallback = false;
    let capturedJobId: string | undefined;
    const identity = {
      pid: 4242,
      incarnation: testIncarnation(1_000),
      processGroupId: 4242,
      childRoot: { pid: 4243, incarnation: testIncarnation(1_001) },
    };
    const status = {
      kind: 'held' as const,
      reason: 'containment observation unavailable',
      retryIntervalMs: 500,
      abandonment: 'abort-job' as const,
    };
    const control = { retry: vi.fn(), abandon: vi.fn(() => true) };
    const spawner: ProviderDurableSpawner = {
      spawnDurableJob: (options) => {
        capturedOptionsHadCallback = typeof options.onDurableProcessIdentity === 'function';
        capturedJobId = options.jobId;
        options.onDurableProcessIdentity?.(identity, status, control);
        return Promise.resolve(NO_CLI_RESULT);
      },
    };
    const onDurableProcessIdentity = vi.fn();

    const runCli = bindProviderRunner(
      spawner,
      'codex',
      new AbortController().signal,
      'default',
      '/tmp/job-dir',
      undefined,
      onDurableProcessIdentity,
      'job-visible-hold',
    );
    await runCli({ command: 'codex', args: [] });

    expect(capturedOptionsHadCallback).toBe(true);
    expect(capturedJobId).toBe('job-visible-hold');
    expect(onDurableProcessIdentity).toHaveBeenCalledExactlyOnceWith(identity, status, control);
  });

  it('passes no onDurableProcessIdentity through when the caller supplies none', async () => {
    let received: unknown;
    const spawner: ProviderDurableSpawner = {
      spawnDurableJob: (options) => {
        received = options.onDurableProcessIdentity;
        return Promise.resolve(NO_CLI_RESULT);
      },
    };

    const runCli = bindProviderRunner(spawner, 'codex', new AbortController().signal, 'default', '/tmp/job-dir');
    await runCli({ command: 'codex', args: [] });

    expect(received).toBeUndefined();
  });
});
