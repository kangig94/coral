import { describe, expect, it } from 'vitest';

import { childPrincipalAuthFromEnv, CORAL_CHILD_PRINCIPAL_HANDLE } from '#src/transport/ipc/child-principal-auth.js';

describe('childPrincipalAuthFromEnv', () => {
  it('builds child IPC auth metadata with a fresh nonce, job binding, and session binding', () => {
    let nonce = 0;
    const auth = childPrincipalAuthFromEnv(
      {
        CORAL_CHILD: '1',
        [CORAL_CHILD_PRINCIPAL_HANDLE]: 'handle-a',
        CORAL_JOB_ID: 'job-a',
        CORAL_SESSION_ID: 'session-a',
      },
      () => `nonce-${++nonce}`,
    );

    expect(typeof auth).toBe('function');
    expect(auth?.()).toEqual({
      kind: 'child',
      handle: 'handle-a',
      token: 'nonce-1',
      jobId: 'job-a',
      sessionId: 'session-a',
    });
    expect(auth?.()).toMatchObject({ token: 'nonce-2' });
  });

  it('fails closed when a child marker or partial child binding is present without a complete handle', () => {
    expect(childPrincipalAuthFromEnv({ CORAL_CHILD: '1' })).toBeNull();
    expect(
      childPrincipalAuthFromEnv({
        [CORAL_CHILD_PRINCIPAL_HANDLE]: 'handle-a',
        CORAL_JOB_ID: 'job-a',
      }),
    ).toBeNull();
  });

  it('leaves non-child CLI invocations on the caller-provided auth path', () => {
    expect(childPrincipalAuthFromEnv({})).toBeUndefined();
  });
});
