import { randomBytes } from 'node:crypto';

import { CORAL_CHILD_PRINCIPAL_HANDLE } from '../../security/child-principal-env.js';
import type { IpcAuthMetadata } from './json-rpc.js';

export { CORAL_CHILD_PRINCIPAL_HANDLE };

export type ChildPrincipalEnv = Partial<
  Record<'CORAL_CHILD' | 'CORAL_JOB_ID' | 'CORAL_SESSION_ID' | typeof CORAL_CHILD_PRINCIPAL_HANDLE, string | undefined>
> &
  Record<string, string | undefined>;

export type ChildPrincipalNonceFactory = () => string;

function defaultNonce(): string {
  return randomBytes(16).toString('hex');
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function childPrincipalAuthFromEnv(
  env: ChildPrincipalEnv = process.env,
  nonce: ChildPrincipalNonceFactory = defaultNonce,
): (() => IpcAuthMetadata) | null | undefined {
  const handle = nonEmpty(env[CORAL_CHILD_PRINCIPAL_HANDLE]);
  const jobId = nonEmpty(env.CORAL_JOB_ID);
  const sessionId = nonEmpty(env.CORAL_SESSION_ID);

  if (handle && jobId && sessionId) {
    return () => ({
      kind: 'child',
      handle,
      token: nonce(),
      jobId,
      sessionId,
    });
  }

  return env.CORAL_CHILD === '1' || handle !== undefined || jobId !== undefined || sessionId !== undefined
    ? null
    : undefined;
}
