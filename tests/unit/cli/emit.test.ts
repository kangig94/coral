import { afterEach, describe, expect, it, vi } from 'vitest';

import { emitError, isAcceptedLaunchResponse } from '#src/cli/emit.js';
import { StoreResetCliError } from '#src/cli/errors.js';
import { HandoffRunError } from '#src/coordinator/handoff-runner.js';
import { BackendUnreachableError, TransientHttpError } from '#src/infra/http-errors.js';
import { BackendToolHttpError } from '#src/transport/http/errors.js';
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

describe('handoff publication error emission', () => {
  it.each([
    {
      label: 'backend unreachable',
      error: () => new BackendUnreachableError('Backend could not be reached.'),
      exitCode: 69,
      errorTag: 'code=backend_unreachable',
    },
    {
      label: 'internal error',
      error: () => new Error('unexpected failure'),
      exitCode: 70,
      errorTag: 'code=internal',
    },
    {
      label: 'transient error',
      error: () => new TransientHttpError(503, 'retry later'),
      exitCode: 75,
      errorTag: 'code=transient',
    },
    {
      label: 'permission HTTP error',
      error: () =>
        new BackendToolHttpError('denied', 403, {
          code: 'missing_capability',
          message: 'denied',
        }),
      exitCode: 77,
      errorTag: 'code=missing_capability, http=403',
    },
  ])('preserves the $exitCode classification for a wrapped $label', ({ error, exitCode, errorTag }) => {
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);

    emitError(new HandoffRunError(error(), [{ phase: 'selection', kind: 'not-published', cause: 'contended' }]));

    expect(stderr).toContain('Handoff routing-status selection publication was not published (contended).\n');
    expect(stderr).toContain(
      'Next step: rerun coral-cli backend status, then retry the operation if the invocation is still unresolved.\n',
    );
    expect(stderr).toContain(`[${errorTag}]`);
    expect(process.exitCode).toBe(exitCode);
  });
});
