import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { bindProviderRunner, type ProviderDurableSpawner } from '#src/providers/cli-runner.js';

const NO_CLI_RESULT = { stdout: '', stderr: '', code: 0, aborted: false };

describe('bindProviderRunner', () => {
  it('forwards onDurableProcessIdentity to the spawner, and the spawner call reaches the caller', async () => {
    let capturedOptionsHadCallback = false;
    const spawner: ProviderDurableSpawner = {
      spawnDurableJob: (options) => {
        capturedOptionsHadCallback = typeof options.onDurableProcessIdentity === 'function';
        options.onDurableProcessIdentity?.({ pid: 4242, incarnation: testIncarnation(1_000) });
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
    );
    await runCli({ command: 'codex', args: [] });

    expect(capturedOptionsHadCallback).toBe(true);
    expect(onDurableProcessIdentity).toHaveBeenCalledExactlyOnceWith({
      pid: 4242,
      incarnation: testIncarnation(1_000),
    });
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
