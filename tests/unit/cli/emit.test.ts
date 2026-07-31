import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitError, isAcceptedLaunchResponse } from '#src/cli/emit.js';
import { StoreResetCliError } from '#src/cli/errors.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';

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
    expect(stderr).toBe(
      'Store-reset reporting failed. [code=store_reset_reporting_failed]\n' +
        'remediation: Retry once. If it still fails, file a Store-reset incident issue with this fixed error output; do not move, restore, delete, or attach DB, WAL, SHM, or raw logs.\n',
    );
    expect(process.exitCode).toBe(70);
  });
});

describe('IPC authorization error emission', () => {
  it('renders nested capability denial with its public code and permission exit', () => {
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

    emitError(
      new IpcRpcError({
        code: -32603,
        message: 'This nested Coral session cannot perform this command. Ask the top-level Coral session to run it.',
        data: {
          code: 'missing_capability',
          message: 'This nested Coral session cannot perform this command. Ask the top-level Coral session to run it.',
        },
      }),
    );

    expect(stdout).toBe('');
    expect(stderr).toBe(
      'This nested Coral session cannot perform this command. Ask the top-level Coral session to run it. [code=missing_capability]\n',
    );
    expect(process.exitCode).toBe(77);
  });
});
