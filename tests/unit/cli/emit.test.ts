import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitError, isAcceptedLaunchResponse } from '#src/cli/emit.js';
import { StoreResetCliError } from '#src/cli/errors.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('accepted launch response decoding', () => {
  it('accepts only the current provider-session contract', () => {
    expect(
      isAcceptedLaunchResponse({
        kind: 'provider-session',
        launchState: 'running',
        jobId: 'job-1',
        sessionId: 'session-1',
      }),
    ).toBe(true);
    expect(
      isAcceptedLaunchResponse({
        kind: 'provider-session',
        launchState: 'running',
        jobId: 'job-1',
        sessionId: 'session-1',
        job: 'legacy-job',
      }),
    ).toBe(false);
    expect(
      isAcceptedLaunchResponse({
        kind: 'provider-session',
        launchState: 'running',
        job: 'legacy-job',
        session: 'legacy-session',
      }),
    ).toBe(false);
  });

  it('requires an explicit workflow id and rejects a provider-session field', () => {
    expect(
      isAcceptedLaunchResponse({
        kind: 'workflow',
        launchState: 'queued',
        jobId: 'workflow-1',
        workflowId: 'workflow-1',
      }),
    ).toBe(true);
    expect(
      isAcceptedLaunchResponse({
        kind: 'workflow',
        launchState: 'queued',
        jobId: 'workflow-1',
      }),
    ).toBe(false);
    expect(
      isAcceptedLaunchResponse({
        kind: 'workflow',
        launchState: 'queued',
        jobId: 'workflow-1',
        workflowId: 'workflow-1',
        sessionId: 'not-a-provider-session',
      }),
    ).toBe(false);
  });
});

describe('store-reset error emission', () => {
  it('writes only the fixed envelope to stderr and leaves stdout empty', () => {
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);

    emitError(new StoreResetCliError('store_reset_reporting_failed'));

    expect(stdout).toBe('');
    expect(stderr).toBe('Store-reset reporting failed. [code=store_reset_reporting_failed]\n');
    expect(process.exitCode).toBe(70);
  });
});
