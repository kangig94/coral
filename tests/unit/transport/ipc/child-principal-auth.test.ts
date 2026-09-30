import { describe, expect, it } from 'vitest';

import {
  ChildPrincipalBindingError,
  childPrincipalAuthFromEnv,
  childPrincipalAuthOptions,
} from '#src/transport/ipc/child-principal-auth.js';
import {
  CORAL_CHILD_CREDENTIAL_ID,
  CORAL_CHILD_CREDENTIAL_KEY,
  CORAL_CHILD_PRINCIPAL_HANDLE,
  isCoralChildEnvironment,
} from '#src/security/child-principal-env.js';
import { mintChildCredentialKeyPair } from '#src/security/child-credential.js';

describe('isCoralChildEnvironment', () => {
  it('recognizes the child marker and non-empty complete or partial bindings', () => {
    expect(isCoralChildEnvironment({ CORAL_CHILD: '1' })).toBe(true);
    expect(isCoralChildEnvironment({ CORAL_JOB_ID: 'job-a' })).toBe(true);
    expect(isCoralChildEnvironment({ [CORAL_CHILD_PRINCIPAL_HANDLE]: 'handle-a' })).toBe(true);
    expect(isCoralChildEnvironment({ [CORAL_CHILD_CREDENTIAL_ID]: 'credential-a' })).toBe(true);
    expect(isCoralChildEnvironment({ [CORAL_CHILD_CREDENTIAL_KEY]: 'key-a' })).toBe(true);
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
  it('should answer a challenge with a proof that carries no private key material', () => {
    const keys = mintChildCredentialKeyPair();
    const auth = childPrincipalAuthFromEnv({
      [CORAL_CHILD_CREDENTIAL_ID]: 'credential-a',
      [CORAL_CHILD_CREDENTIAL_KEY]: keys.privateKey,
      CORAL_JOB_ID: 'job-a',
      CORAL_SESSION_ID: 'session-a',
    });
    if (auth === null || auth === undefined || typeof auth === 'function') throw new Error('Expected challenged auth.');

    const proof = auth.prove(
      { challenge: 'challenge-a', incarnation: 'incarnation-a', namespace: 'ns-a' },
      { method: 'jobs.list', id: 1, params: {} },
    );

    expect(proof).toMatchObject({
      kind: 'child-proof',
      credentialId: 'credential-a',
      jobId: 'job-a',
      sessionId: 'session-a',
    });
    expect(JSON.stringify(proof)).not.toContain(keys.privateKey);
  });

  it('should never fall back to the bearer handle when a credential is present, even an incomplete one', () => {
    const keys = mintChildCredentialKeyPair();
    const auth = childPrincipalAuthFromEnv({
      [CORAL_CHILD_PRINCIPAL_HANDLE]: 'handle-a',
      [CORAL_CHILD_CREDENTIAL_ID]: 'credential-a',
      [CORAL_CHILD_CREDENTIAL_KEY]: keys.privateKey,
      CORAL_JOB_ID: 'job-a',
      CORAL_SESSION_ID: 'session-a',
    });

    expect(auth).toMatchObject({ kind: 'challenged' });
    expect(
      childPrincipalAuthFromEnv({
        [CORAL_CHILD_PRINCIPAL_HANDLE]: 'handle-a',
        [CORAL_CHILD_CREDENTIAL_ID]: 'credential-a',
        CORAL_JOB_ID: 'job-a',
        CORAL_SESSION_ID: 'session-a',
      }),
    ).toBeNull();
  });

  it('builds bearer IPC auth with a fresh nonce for a credential only a shipped coordinator issued', () => {
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

    if (typeof auth !== 'function') throw new Error('Expected the bearer auth a shipped coordinator accepts.');
    expect(auth()).toEqual({
      kind: 'child',
      handle: 'handle-a',
      token: 'nonce-1',
      jobId: 'job-a',
      sessionId: 'session-a',
    });
    expect(auth()).toMatchObject({ token: 'nonce-2' });
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
