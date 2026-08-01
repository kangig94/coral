import { describe, expect, it } from 'vitest';

import {
  ChildPrincipalBindingError,
  childPrincipalAuthFromEnv,
  childPrincipalAuthOptions,
  CORAL_CHILD_PRINCIPAL_HANDLE,
} from '#src/transport/ipc/child-principal-auth.js';
import { isCoralChildEnvironment } from '#src/security/child-principal-env.js';

describe('isCoralChildEnvironment', () => {
  it('recognizes the child marker and non-empty complete or partial bindings', () => {
    expect(isCoralChildEnvironment({ CORAL_CHILD: '1' })).toBe(true);
    expect(isCoralChildEnvironment({ CORAL_JOB_ID: 'job-a' })).toBe(true);
    expect(isCoralChildEnvironment({ [CORAL_CHILD_PRINCIPAL_HANDLE]: 'handle-a' })).toBe(true);
  });

  it('keeps empty exports and non-marker values equivalent to unset', () => {
    expect(
      isCoralChildEnvironment({
        CORAL_CHILD: '0',
        CORAL_JOB_ID: '',
        CORAL_SESSION_ID: '',
        [CORAL_CHILD_PRINCIPAL_HANDLE]: '',
      }),
    ).toBe(false);
  });
});

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

  it('turns an incomplete binding into an actionable public error before IPC work', () => {
    expect(() => childPrincipalAuthOptions(null)).toThrow(ChildPrincipalBindingError);
    expect(() => childPrincipalAuthOptions(null)).toThrow('incomplete child credentials and was not sent');
  });

  it('leaves non-child CLI invocations on the caller-provided auth path', () => {
    expect(childPrincipalAuthFromEnv({})).toBeUndefined();
  });
});
